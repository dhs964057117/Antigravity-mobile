import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getChatHistory, loadOlderMessages } from '../server.js';

test('history polling reads sidebar rows without opening search or dispatching Escape', async () => {
    let interactions = 0;
    const row = {
        innerText: 'Current task\nworkspace\nnow', className: 'bg-sidebar-secondary',
        querySelector: () => null, getAttribute: () => null
    };
    const context = vm.createContext({
        document: {
            querySelectorAll: selector => selector === '[data-testid="conversation-row-sidebar"]' ? [row] : [],
            querySelector: () => ({ dispatchEvent() { interactions++; } }),
            dispatchEvent() { interactions++; }
        },
        MouseEvent: class {}, KeyboardEvent: class {}, setTimeout
    });
    const result = await getChatHistory({ contexts: [{ id: 1 }], async call(method, params) {
        return { result: { value: await vm.runInContext(params.expression, context) } };
    } });
    assert.equal(result.success, true);
    assert.equal(result.chats[0].title, 'Current task');
    assert.equal(result.chats[0].group, 'Projects');
    assert.equal(interactions, 0);
});

test('loadOlderMessages triggers click on load button when present in desktop DOM', async () => {
    let clicked = false;
    const loadBtn = {
        getAttribute: name => name === 'aria-label' ? 'Load older messages, showing 20 of 100' : null,
        click: () => { clicked = true; }
    };
    const context = vm.createContext({
        document: {
            querySelector: selector => selector.includes('Load older messages') ? loadBtn : null,
            querySelectorAll: () => []
        }
    });
    const result = await loadOlderMessages({ contexts: [{ id: 1 }], async call(method, params) {
        return { result: { value: await vm.runInContext(params.expression, context) } };
    } });
    assert.equal(result.success, true);
    assert.equal(result.clicked, true);
    assert.equal(clicked, true);
    assert.equal(result.before, 'Load older messages, showing 20 of 100');
});
