// Must be first to set up globals
import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { deeplyFulfilledObject } from '@agoric/internal';
import { makeHeapZone } from '@agoric/zone';
import { eventLoopIteration } from '@agoric/internal/src/testing-utils.js';
import { MockCctpTxEvidences } from '@agoric/fast-usdc/tools/mock-evidence.js';
import {
  prepareTransactionFeedKit,
  stateShape,
  type TransactionFeedKit,
} from '../../src/exos/transaction-feed.ts';

const nullZcf = null as any;

const makeFeedKit = () => {
  const zone = makeHeapZone();
  const makeKit = prepareTransactionFeedKit(zone, nullZcf);
  return makeKit();
};

const makeOperators = (feedKit: TransactionFeedKit) => {
  const operators = Object.fromEntries(
    ['op1', 'op2', 'op3'].map(name => [
      name,
      feedKit.creator.initOperator(name),
    ]),
  );
  return deeplyFulfilledObject(harden(operators));
};

test('stateShape', t => {
  t.snapshot(stateShape);
});

test('facets', t => {
  const kit = makeFeedKit();
  t.deepEqual(Object.keys(kit).sort(), ['creator', 'operatorPowers', 'public']);
});

test('status shape', async t => {
  const { op1 } = await makeOperators(makeFeedKit());

  // status shape
  t.deepEqual(op1.operator.getStatus(), {
    disabled: false,
    operatorId: 'op1',
  });
});

test('happy aggregation', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();

  const { op1, op2, op3 } = await makeOperators(feedKit);

  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  op1.operator.submitEvidence(e1);
  op2.operator.submitEvidence(e1);

  // Publishes with 2 of 3
  const accepted = await evidenceSubscriber.getUpdateSince(0);
  t.deepEqual(accepted, {
    value: { evidence: e1, risk: { risksIdentified: [] } },
    updateCount: 1n,
  });

  // Now third operator catches up with same evidence already published
  op3.operator.submitEvidence(e1);
  t.like(await evidenceSubscriber.getUpdateSince(0), {
    // The confirming evidence doesn't change anything
    updateCount: 1n,
  });

  const e2 = MockCctpTxEvidences.AGORIC_PLUS_DYDX();
  assert(e1.txHash !== e2.txHash);
  op1.operator.submitEvidence(e2);
  t.like(await evidenceSubscriber.getUpdateSince(0), {
    // op1 attestation insufficient
    updateCount: 1n,
  });
});

test('takes union of risk assessments', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();

  const { op1, op2 } = await makeOperators(feedKit);

  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  op1.operator.submitEvidence(e1, { risksIdentified: ['RISK1'] });
  op2.operator.submitEvidence(e1, { risksIdentified: ['RISK2'] });

  // Publishes with 2 of 3
  const accepted = await evidenceSubscriber.getUpdateSince(0);
  t.deepEqual(accepted, {
    value: { evidence: e1, risk: { risksIdentified: ['RISK1', 'RISK2'] } },
    updateCount: 1n,
  });
});

test('takes union of risk assessments pt. 2', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();

  const { op1, op2 } = await makeOperators(feedKit);

  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  op1.operator.submitEvidence(e1, { risksIdentified: ['RISK1'] });
  op2.operator.submitEvidence(e1);

  // Publishes with 2 of 3
  const accepted = await evidenceSubscriber.getUpdateSince(0);
  t.deepEqual(accepted, {
    value: { evidence: e1, risk: { risksIdentified: ['RISK1'] } },
    updateCount: 1n,
  });
});

test('takes union of risk assessments pt. 3', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();

  const { op1, op2 } = await makeOperators(feedKit);

  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  op1.operator.submitEvidence(e1, { risksIdentified: ['RISK1'] });
  op2.operator.submitEvidence(e1, { risksIdentified: ['RISK1'] });

  // Publishes with 2 of 3
  const accepted = await evidenceSubscriber.getUpdateSince(0);
  t.deepEqual(accepted, {
    value: { evidence: e1, risk: { risksIdentified: ['RISK1'] } },
    updateCount: 1n,
  });
});

test('takes union of risk assessments pt. 4', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();

  const { op1, op2 } = await makeOperators(feedKit);

  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  op1.operator.submitEvidence(e1);
  op2.operator.submitEvidence(e1);

  // Publishes with 2 of 3
  const accepted = await evidenceSubscriber.getUpdateSince(0);
  t.deepEqual(accepted, {
    value: { evidence: e1, risk: { risksIdentified: [] } },
    updateCount: 1n,
  });
});

test('disagreement', async t => {
  const feedKit = makeFeedKit();
  const { op1, op2 } = await makeOperators(feedKit);
  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  const e1bad = { ...e1, tx: { ...e1.tx, amount: 999_999_999n } };
  assert(e1.txHash === e1bad.txHash);
  op1.operator.submitEvidence(e1);

  // conflicting between operators
  t.throws(() => op2.operator.submitEvidence(e1bad), {
    message: /conflicting evidence/,
  });

  // self conflicting
  t.throws(() => op1.operator.submitEvidence(e1bad), {
    message: /conflicting evidence/,
  });
});

test('disagreement after publishing', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();
  const { op1, op2, op3 } = await makeOperators(feedKit);
  const e1 = MockCctpTxEvidences.AGORIC_PLUS_OSMO();
  const e1bad = { ...e1, tx: { ...e1.tx, amount: 999_999_999n } };
  assert(e1.txHash === e1bad.txHash);
  op1.operator.submitEvidence(e1);
  op2.operator.submitEvidence(e1);

  t.like(await evidenceSubscriber.getUpdateSince(0), {
    updateCount: 1n,
  });

  t.throws(() => op3.operator.submitEvidence(e1bad), {
    message: /conflicting evidence/,
  });
  t.like(await evidenceSubscriber.getUpdateSince(0), {
    updateCount: 1n,
  });

  // Disagreement is still detected after publishing
  t.throws(() => op1.operator.submitEvidence(e1bad), {
    message: /conflicting evidence/,
  });
  t.like(await evidenceSubscriber.getUpdateSince(0), {
    updateCount: 1n,
  });
});

test('remove operator', async t => {
  const feedKit = makeFeedKit();
  const evidenceSubscriber = feedKit.public.getEvidenceSubscriber();
  const { op1, op2 } = await makeOperators(feedKit);
  const evidence = MockCctpTxEvidences.AGORIC_PLUS_OSMO();

  let published;
  void evidenceSubscriber
    .getUpdateSince(0)
    .then(accepted => (published = accepted.value.evidence));

  // works before disabling
  op1.operator.submitEvidence(evidence);
  await eventLoopIteration();
  t.falsy(published);

  // remove op1 and their in-flight evidence
  feedKit.creator.removeOperator('op1');
  t.throws(() => op1.operator.submitEvidence(evidence), {
    message: 'submitEvidence for disabled operator',
  });

  // one attestation is now sufficient (half of two) but the only evidence was just removed
  await eventLoopIteration();
  t.falsy(published);
  op2.operator.submitEvidence(evidence);
  await eventLoopIteration();
  t.deepEqual(published, evidence);
});
