// SPDX-License-Identifier: Apache-2.0

import fc from 'fast-check';
import { stub } from 'sinon';
import { expect } from 'chai';
import { RetryUtils } from '../../../src/utils/RetryUtils';

describe('RetryUtils property tests', () => {
  const backOff = 0;

  // Generates a maxRetries value together with a number of failures that is
  // strictly lower than it, so the task always succeeds before giving up.
  const maxRetriesWithRecoverableFailures = fc
    .integer({ min: 1, max: 10 })
    .chain((maxRetries) => fc.tuple(fc.constant(maxRetries), fc.integer({ min: 0, max: maxRetries - 1 })));

  it('should resolve with the task result when it succeeds before the retries are exhausted', async () => {
    await fc.assert(
      fc.asyncProperty(maxRetriesWithRecoverableFailures, fc.string(), async ([maxRetries, failures], value) => {
        const error = new Error('Task failed');
        const task = stub();
        for (let i = 0; i < failures; i++) {
          task.onCall(i).rejects(error);
        }
        task.onCall(failures).resolves(value);
        const doOnRetry = stub();

        const result = await RetryUtils.retryTask(task, { maxRetries, backOff, doOnRetry });

        expect(result).to.equal(value);
        expect(task.callCount).to.equal(failures + 1);
        expect(doOnRetry.callCount).to.equal(failures);
        for (let i = 0; i < failures; i++) {
          expect(doOnRetry.getCall(i).args[0]).to.equal(error);
        }
      })
    );
  });

  it('should call the task exactly maxRetries times and rethrow when it never succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (maxRetries) => {
        const error = new Error('Task failed');
        const task = stub().rejects(error);
        const doOnRetry = stub();

        let caught: unknown;
        try {
          await RetryUtils.retryTask(task, { maxRetries, backOff, doOnRetry });
        } catch (e) {
          caught = e;
        }

        expect(caught).to.equal(error);
        expect(task.callCount).to.equal(maxRetries);
        expect(doOnRetry.callCount).to.equal(maxRetries - 1);
      })
    );
  });

  it('should stop retrying as soon as shouldRetry rejects the error', async () => {
    await fc.assert(
      fc.asyncProperty(maxRetriesWithRecoverableFailures, async ([maxRetries, retryableFailures]) => {
        const retryableError = new Error('Retryable error');
        const nonRetryableError = new Error('Non-retryable error');
        const task = stub();
        for (let i = 0; i < retryableFailures; i++) {
          task.onCall(i).rejects(retryableError);
        }
        task.onCall(retryableFailures).rejects(nonRetryableError);
        const shouldRetry = (e: unknown) => e === retryableError;
        const doOnRetry = stub();

        let caught: unknown;
        try {
          await RetryUtils.retryTask(task, { maxRetries, backOff, shouldRetry, doOnRetry });
        } catch (e) {
          caught = e;
        }

        expect(caught).to.equal(nonRetryableError);
        expect(task.callCount).to.equal(retryableFailures + 1);
        expect(doOnRetry.callCount).to.equal(retryableFailures);
      })
    );
  });
});
