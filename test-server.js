#!/usr/bin/env node
const {spawn} = require('child_process');

const chalk = require('chalk');
const sodium = require('chloride');

const {createMsg1, verifyMsg2, createMsg3, verifyMsg4, clientOutcome} = require('shs1-crypto');
const randomBytes = require('./random-bytes');
const runTests = require('./run-tests');

const serverPath = process.argv[2];
const seed = process.argv[3];

const generateClientStartState = rnd => {
  const client_longterm = sodium.crypto_sign_seed_keypair(randomBytes(rnd, 32));
  const client_ephemeral = sodium.crypto_sign_seed_keypair(randomBytes(rnd, 32));
  const network_identifier = randomBytes(rnd, 32);
  const server_longterm = sodium.crypto_sign_seed_keypair(randomBytes(rnd, 32));

  return {
    client_longterm_sk: client_longterm.secretKey,
    client_longterm_pk: client_longterm.publicKey,
    client_ephemeral_sk: sodium.crypto_sign_ed25519_sk_to_curve25519(client_ephemeral.secretKey),
    client_ephemeral_pk: sodium.crypto_sign_ed25519_pk_to_curve25519(client_ephemeral.publicKey),
    network_identifier,
    // Only put server_longterm_sk here so that it can be passed as an argument
    // to the server script. The tests then delete it from the clientState.
    server_longterm_sk: server_longterm.secretKey,
    server_longterm_pk: server_longterm.publicKey
  };
};

const startServer = clientState => {
  const server_longterm_sk = clientState.server_longterm_sk;
  clientState.server_longterm_sk = undefined;

  return spawn(serverPath, [
    clientState.network_identifier.toString('hex'),
    server_longterm_sk.toString('hex'),
    clientState.server_longterm_pk.toString('hex')
  ]);
};

const interact = (clientState, server, faults, cb) => {
  let once = true;
  const done = err => {
    if (once) {
      once = false;

      server.kill();
      return cb(err);
    }
  };

  server.on('error', err => {
    done({
      description: 'server child_process emitted error event',
      err
    });
  });

  server.stderr.on('data', data => process.stderr.write(data));

  const trace = {
    client_longterm_sk: Buffer.alloc(64),
    client_longterm_pk: Buffer.alloc(32),
    client_ephemeral_sk: Buffer.alloc(32),
    client_ephemeral_pk: Buffer.alloc(32),
    server_longterm_pk: Buffer.alloc(32),
    network_identifier: Buffer.alloc(32)
  };
  clientState.client_longterm_sk.copy(trace.client_longterm_sk);
  clientState.client_longterm_pk.copy(trace.client_longterm_pk);
  clientState.client_ephemeral_sk.copy(trace.client_ephemeral_sk);
  clientState.client_ephemeral_pk.copy(trace.client_ephemeral_pk);
  clientState.server_longterm_pk.copy(trace.server_longterm_pk);
  clientState.network_identifier.copy(trace.network_identifier);

  let state;
  let offset = 0;
  const bytes = Buffer.alloc(192);

  if (faults.msg1) {
    const msg1 = faults.msg1(clientState);

    trace.invalidMsg1 = Buffer.alloc(64);
    msg1.copy(trace.invalidMsg1);

    server.stdin.write(msg1);
    state = 'sent_invalid_msg1';
  } else {
    const msg1 = createMsg1(clientState);

    trace.msg1 = Buffer.alloc(64);
    msg1.copy(trace.msg1);

    server.stdin.write(msg1);
    state = 'sent_valid_msg1';
  }

  server.stdout.on('data', data => {
    switch (state) {
      case 'sent_invalid_msg1':
        return done({
          description: 'Server must stop writing after receiving invalid msg1',
          trace
        });
      case 'sent_valid_msg1':
        {
          if (data.length > (64 - offset)) {
            return done({
              description: 'Server wrote too many bytes for msg2',
              trace,
              incorrectMsgFromServer: data
            });
          }
          data.copy(bytes, offset);
          offset += data.length;

          if (offset < 64) {
            return;
          }
          offset = 0;

          const msg2 = Buffer.alloc(64);
          bytes.copy(msg2, 0, 0, 64);
          if (!verifyMsg2(clientState, msg2)) {
            return done({
              description: 'Server wrote invalid msg2',
              trace,
              incorrectMsgFromServer: msg2
            });
          }

          trace.msg2 = Buffer.alloc(64);
          msg2.copy(trace.msg2);
          trace.server_ephemeral_pk = clientState.server_ephemeral_pk;

          if (faults.msg3) {
            const msg3 = faults.msg3(clientState);

            trace.invalidMsg3 = Buffer.alloc(112);
            msg3.copy(trace.invalidMsg3);

            server.stdin.write(msg3);
            state = 'sent_invalid_msg3';
          } else {
            const msg3 = createMsg3(clientState);

            trace.msg3 = Buffer.alloc(112);
            msg3.copy(trace.msg3);
            trace.shared_secret_ab = clientState.shared_secret_ab;
            trace.shared_secret_aB = clientState.shared_secret_aB;
            trace.msg3_plaintext = clientState.msg3_plaintext;

            server.stdin.write(msg3);
            state = 'sent_valid_msg3';
          }
          return;
        }
      case 'sent_invalid_msg3':
        return done({
          description: 'Server must stop writing after receiving invalid msg3',
          trace
        });
      case 'sent_valid_msg3':
        {
          if (data.length > (192 - offset)) {
            return done({
              description: 'Server wrote too many bytes for msg4 and outcome',
              trace,
              incorrectMsgFromServer: data
            });
          }

          data.copy(bytes, offset);
          offset += data.length;

          if (offset < 192) {
            return;
          }

          const msg4 = Buffer.alloc(80);
          bytes.copy(msg4, 0, 0, 80);
          if (!verifyMsg4(clientState, msg4)) {
            return done({
              description: 'Server wrote invalid msg4',
              trace,
              incorrectMsgFromServer: msg4
            });
          }

          trace.msg4 = msg4;
          trace.msg4_secretbox_key_hash = clientState.msg4_secretbox_key_hash;

          const expectedOutcome = clientOutcome(clientState);
          const receivedOutcomeBuffer = Buffer.alloc(112);
          bytes.copy(receivedOutcomeBuffer, 0, 80, 192);
          if (receivedOutcomeBuffer.equals(Buffer.concat([
            expectedOutcome.decryption_key,
            expectedOutcome.decryption_nonce,
            expectedOutcome.encryption_key,
            expectedOutcome.encryption_nonce
          ]))) {
            return done();
          }

          trace.expected_outcome = Buffer.concat([
            expectedOutcome.decryption_key,
            expectedOutcome.decryption_nonce,
            expectedOutcome.encryption_key,
            expectedOutcome.encryption_nonce
          ]);

          return done({
            description: 'Server wrote incorrect outcome',
            trace,
            incorrectMsgFromServer: receivedOutcomeBuffer
          });
        }
      default: throw new Error('The test suite messed up.'); // Never happens (we have control over the state machine)
    }
  });

  server.on('close', code => {
    switch (state) {
      case 'sent_invalid_msg1':
        if (code === 0) {
          return done({
            description: 'Server must exit with nonzero exit code upon receiving a faulty msg1, but the server exited with code 0.',
            trace
          });
        }
        return done();
      case 'sent_invalid_msg3':
        if (code === 0) {
          return done({
            description: 'Server must exit with nonzero exit code upon receiving a faulty msg3, but the server exited with code 0.',
            trace
          });
        }
        return done();
      default: return done({
        description: 'Server closed although the client was well-behaved.',
        trace
      });
    }
  });
};

/*
 * Tests
 */

// Well-behaved client.
const testSuccess = (clientState, cb) => {
  const server = startServer(clientState);
  interact(clientState, server, {}, cb);
};

// Client sends a random msg1.
const testMsg1FullyRandom = (clientState, cb, rnd) => {
  const invalidMsg1 = randomBytes(rnd, 64);

  const server = startServer(clientState);
  interact(clientState, server, {
    msg1: () => invalidMsg1
  }, cb);
};

// Client uses a random network_identifier to compute msg1.
const testMsg1NetworkIdentifierRandom = (clientState, cb, rnd) => {
  const random_network_identifier = randomBytes(rnd, 32);

  const server = startServer(clientState);
  interact(clientState, server, {
    msg1: clientState => {
      const hmac = sodium.crypto_auth(clientState.client_ephemeral_pk, random_network_identifier);
      return Buffer.concat([hmac, clientState.client_ephemeral_pk]);
    }
  }, cb);
};

// Client sends a random msg3.
const testMsg3FullyRandom = (clientState, cb, rnd) => {
  const invalidMsg3 = randomBytes(rnd, 112);

  const server = startServer(clientState);
  interact(clientState, server, {
    msg3: () => invalidMsg3
  }, cb);
};

// Client uses a random msg3_secretbox_key to sign msg3.
const testMsg3SecretboxKeyRandom = (clientState, cb, rnd) => {
  const random_msg3_secretbox_key = randomBytes(rnd, 32);

  const server = startServer(clientState);
  interact(clientState, server, {
    msg3: clientState => {
      const shared_secret_ab = sodium.crypto_scalarmult(clientState.client_ephemeral_sk, clientState.server_ephemeral_pk);
      const shared_secret_ab_hashed = sodium.crypto_hash_sha256(shared_secret_ab);

      const signed = Buffer.concat([
        clientState.network_identifier,
        clientState.server_longterm_pk,
        shared_secret_ab_hashed
      ]);

      const inner_signature = sodium.crypto_sign_detached(signed, clientState.client_longterm_sk);

      const msg3_plaintext = Buffer.concat([inner_signature, clientState.client_longterm_pk]);

      const msg3_secretbox_key = random_msg3_secretbox_key;

      const zeros = Buffer.alloc(24);
      zeros.fill(0);

      return sodium.crypto_secretbox_easy(msg3_plaintext, zeros, msg3_secretbox_key);
    }
  }, cb);
};

// Client uses a random plaintext signed with the correct key as msg3.
const testMsg3PlaintextRandom = (clientState, cb, rnd) => {
  const random_msg3_plaintext = randomBytes(rnd, 96);

  const server = startServer(clientState);
  interact(clientState, server, {
    msg3: clientState => {
      const shared_secret_ab = sodium.crypto_scalarmult(clientState.client_ephemeral_sk, clientState.server_ephemeral_pk);

      const shared_secret_aB = sodium.crypto_scalarmult(
        clientState.client_ephemeral_sk,
        sodium.crypto_sign_ed25519_pk_to_curve25519(clientState.server_longterm_pk)
      );

      const msg3_secretbox_key = sodium.crypto_hash_sha256(Buffer.concat([
        clientState.network_identifier,
        shared_secret_ab,
        shared_secret_aB
      ]));

      const zeros = Buffer.alloc(24);
      zeros.fill(0);

      return sodium.crypto_secretbox_easy(random_msg3_plaintext, zeros, msg3_secretbox_key);
    }
  }, cb);
};

const tests = [].concat(
  Array(5).fill(testMsg3PlaintextRandom),
  Array(5).fill(testMsg3SecretboxKeyRandom),
  Array(5).fill(testMsg3FullyRandom),
  Array(5).fill(testMsg1NetworkIdentifierRandom),
  Array(5).fill(testMsg1FullyRandom),
  Array(20).fill(testSuccess)
);

/*
 * Run tests
 */

runTests(tests, generateClientStartState, seed, failedTests => {
  if (failedTests > 0) {
    console.log();
    console.log(chalk.red(`Total server test failures: ${failedTests}`));
  } else {
    console.log(chalk.green(`Passed the server test suite =)`));
  }

  process.exit(failedTests);
});
