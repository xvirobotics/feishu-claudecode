import { describe, it, expect, afterEach } from 'vitest';
import { makeKit, type TestKit } from './helpers.js';
import type { Credential } from '../src/auth/credentials.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(kit: TestKit, name: string, role: 'admin' | 'member', overrides: Partial<Credential> = {}): Credential {
  const { credential } = kit.credentials.issue({
    botName: name, ownerName: name, role,
  });
  const full = kit.credentials.findById(credential.id)!;
  return { ...full, ...overrides };
}

describe('MemoryStore + ACL', () => {
  it('admin can write anywhere; member is scoped', () => {
    kit = makeKit('mem-acl');
    const admin = issue(kit, 'admin-a', 'admin');
    const dkj = issue(kit, 'dkj-laptop', 'member');

    // Admin creates /shared/skills folder
    const shared = kit.memory.createFolder({ name: 'shared', parent_id: 'root' }, admin);
    kit.memory.createFolder({ path: '/shared/skills' }, admin);

    // Member writes within their own namespace via path-based create
    const doc = kit.memory.createDocument({
      title: 'My Note',
      path: '/users/dkj-laptop/private/notes/my-note',
      content: '# hello',
    }, dkj);
    expect(doc.path).toBe('/users/dkj-laptop/private/notes/my-note');

    // Member cannot write to /shared
    expect(() => kit!.memory.createDocument({
      title: 'pwn',
      path: '/shared/skills/evil',
      content: 'x',
    }, dkj)).toThrow();

    // Member cannot write to another user's ns
    expect(() => kit!.memory.createDocument({
      title: 'snoop',
      path: '/users/floodsung/private/secrets/y',
      content: 'x',
    }, dkj)).toThrow();

    // Admin can read member's doc
    const adminRead = kit.memory.getDocument(doc.path, admin);
    expect(adminRead?.id).toBe(doc.id);

    // Member can read /shared
    const sharedRead = kit.memory.findFolderByPath('/shared');
    expect(sharedRead).toBeTruthy();
    expect(shared.id).toBeTruthy();
    const sharedList = kit.memory.listFolders('/shared', dkj);
    expect(sharedList.some((f) => f.path === '/shared')).toBe(true);
  });

  it('member cannot read another user namespace', () => {
    kit = makeKit('mem-isolation');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    const docA = kit.memory.createDocument({
      title: 'note', path: '/users/bot-a/private/note', content: 'secret',
    }, a);

    // b can't get a's doc by path
    expect(kit.memory.getDocument(docA.path, b)).toBeNull();
    // admin can
    expect(kit.memory.getDocument(docA.path, admin)?.id).toBe(docA.id);
  });

  it('search results are ACL-filtered', () => {
    kit = makeKit('mem-search');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');
    const b = issue(kit, 'bot-b', 'member');

    kit.memory.createDocument({
      title: 'alpha', path: '/users/bot-a/projects/x/alpha', content: 'lookmeup unique-token',
    }, a);
    kit.memory.createDocument({
      title: 'beta',  path: '/shared/notes/beta',
      content: 'lookmeup public',
    }, admin);

    const adminResults = kit.memory.searchDocuments('lookmeup', 20, admin);
    expect(adminResults.length).toBe(2);

    const bResults = kit.memory.searchDocuments('lookmeup', 20, b);
    // b can only see /shared, not /users/bot-a
    expect(bResults.length).toBe(1);
    expect(bResults[0].path.startsWith('/shared/')).toBe(true);
  });

  it('deleteFolder cascades + enforces ACL', () => {
    kit = makeKit('mem-delete');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');

    kit.memory.createDocument({
      title: 'one', path: '/users/bot-a/projects/x/one', content: '1',
    }, a);
    kit.memory.createDocument({
      title: 'two', path: '/users/bot-a/projects/x/two', content: '2',
    }, a);

    const folder = kit.memory.findFolderByPath('/users/bot-a/projects/x')!;
    // member can delete their own folder
    kit.memory.deleteFolder(folder.path, a);

    // gone
    expect(kit.memory.findFolderByPath('/users/bot-a/projects/x')).toBeNull();
    expect(kit.memory.listDocuments({ prefix: '/users/bot-a/projects/x' }, admin).length).toBe(0);
  });

  it('listFolders applies prefix + ACL', () => {
    kit = makeKit('mem-listfolders');
    const admin = issue(kit, 'admin', 'admin');
    const a = issue(kit, 'bot-a', 'member');

    kit.memory.createDocument({
      title: 'doc', path: '/users/bot-a/projects/proj1/doc', content: '',
    }, a);
    kit.memory.createFolder({ path: '/shared/teamx' }, admin);

    const list = kit.memory.listFolders('/users/bot-a', a);
    for (const f of list) {
      expect(f.path.startsWith('/users/bot-a')).toBe(true);
    }
    // member can't see /shared via /users prefix
    expect(list.some((f) => f.path === '/shared/teamx')).toBe(false);
  });
});
