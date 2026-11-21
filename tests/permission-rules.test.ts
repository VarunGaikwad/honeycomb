import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRules } from '../src/extension/permission-modes/rules.ts';

test('user config accepts trusted rules and default, project config cannot allow/default', () => {
 assert.deepEqual(validateRules({allow:['write:src/*'], defaultMode:'acceptEdits'}, true), {allow:['write:src/*'],defaultMode:'acceptEdits'});
 assert.throws(()=>validateRules({allow:['write:*']},false),/cannot define allow/);
 assert.throws(()=>validateRules({defaultMode:'auto'},false),/untrusted/);
});
test('invalid configuration and rule definitions are rejected',()=>{
 for (const value of [null, [], {allow:['*']}, {deny:'write:*'}, {unknown:[]}]) assert.throws(()=>validateRules(value,true));
});
test('deny and ask rules are recognized as valid restrictive definitions',()=>{
 assert.deepEqual(validateRules({ask:['write:src/*'],deny:['edit:**']},false),{ask:['write:src/*'],deny:['edit:**']});
});
