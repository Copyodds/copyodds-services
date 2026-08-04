import assert from 'node:assert/strict';
import {
  ROBOT_CONTROL_WILDCARD,
  parseRobotControlSubject,
  robotControlSubjectForEvent,
  robotModifySubject,
  robotPauseSubject,
  robotReloadSubject,
  robotResumeSubject,
} from './robotControlSubjects';

const SUB_ID = '550e8400-e29b-41d4-a716-446655440000';

function testSubjectBuilders() {
  assert.equal(robotModifySubject(SUB_ID), `robot.modify.${SUB_ID}`);
  assert.equal(robotPauseSubject(SUB_ID), `robot.pause.${SUB_ID}`);
  assert.equal(robotResumeSubject(SUB_ID), `robot.resume.${SUB_ID}`);
  assert.equal(robotReloadSubject(SUB_ID), `robot.reload.${SUB_ID}`);
  assert.equal(robotControlSubjectForEvent('modify', SUB_ID), `robot.modify.${SUB_ID}`);
}

function testWildcard() {
  assert.equal(ROBOT_CONTROL_WILDCARD, 'robot.*.*');
}

function testParseSubject() {
  const parsed = parseRobotControlSubject(`robot.pause.${SUB_ID}`);
  assert.deepEqual(parsed, { event: 'pause', subscriptionId: SUB_ID });
  assert.equal(parseRobotControlSubject('robot.unknown.x'), null);
  assert.equal(parseRobotControlSubject('other.modify.x'), null);
}

testSubjectBuilders();
testWildcard();
testParseSubject();
console.log('robotControlSubjects.test.ts: ok');
