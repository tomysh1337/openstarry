import test from 'node:test'
import assert from 'node:assert/strict'
import { Workspace } from '../src/model.js'

test('full-disk proposals survive history reload and remain outside project files and exports', () => {
  const workspace = new Workspace({ files: { 'hello.txt': 'project' } })
  const path = 'D:/other-project/hello.txt', proposalId = '11111111-1111-4111-8111-111111111111'
  workspace.proposeExternal(path, 'after', 'before', proposalId)
  const restored = new Workspace(workspace.snapshot())
  assert.equal(restored.content(path), 'before')
  assert.equal(restored.checkProposal(path).webProposalId, proposalId)
  assert.throws(() => restored.edit(path, 'draft'), /相对文件路径/)
  restored.accept(path)
  assert.deepEqual(Object.keys(restored.files), ['hello.txt'])
  assert.equal(restored.proposals[path], undefined)
  assert.ok(!restored.tabs.includes(path))
  assert.deepEqual(restored.diskFiles, {})
})

test('rejecting an external proposal retains project files; ordinary project paths stay relative', () => {
  const workspace = new Workspace({ files: { 'hello.txt': 'project' } })
  const path = 'C:/outside/new.txt'
  workspace.proposeExternal(path, 'new', '', '11111111-1111-4111-8111-111111111111')
  workspace.reject(path)
  assert.deepEqual(workspace.files, Object.assign(Object.create(null), { 'hello.txt': 'project' }))
  assert.throws(() => workspace.propose(path, 'value'), /相对文件路径/)
  assert.throws(() => workspace.proposeExternal('C:/../outside.txt', '', '', 'bad'), /格式错误/)
})
