import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const dmCode = transformSync(
  fs.readFileSync(new URL('../DownloadManager.jsx', import.meta.url), 'utf8'),
  { loader: 'jsx', format: 'cjs' }
).code;

const settingsCode = transformSync(
  fs.readFileSync(new URL('../Settings.jsx', import.meta.url), 'utf8'),
  { loader: 'jsx', format: 'cjs' }
).code;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harnessDM(api, { tasks = [], mergeTasks = [], seriesList = [] } = {}) {
  let cursor = 0, tree;
  const slots = [], effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = initial;
      return [slots[at], (value) => {
        slots[at] = typeof value === 'function' ? value(slots[at]) : value;
      }];
    },
    useRef(initial) {
      const at = cursor++;
      return slots[at] ||= { current: initial };
    },
    useEffect(effect, deps) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        slots[at] = { deps };
        effects.push(() => { slots[at].cleanup = effect(); });
      }
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  const icon = (props) => ({ type: 'icon', props: props || {}, children: [] });
  const module = { exports: {} };
  const require = (id) =>
    id === 'react' ? react
    : id === './useDialogKeyboard' ? () => {}
    : id === './DownloadManager.css' ? {}
    : id === './icons' ? new Proxy({}, { get: () => icon })
    : undefined;

  vm.runInNewContext(dmCode, {
    module,
    exports: module.exports,
    require,
    window: { electronAPI: api },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  slots[0] = tasks;
  slots[4] = seriesList;
  slots[8] = mergeTasks;

  const render = () => {
    cursor = 0;
    tree = module.exports.default({ active: false });
    while (effects.length) effects.shift()();
    return tree;
  };

  const find = (predicate, root = tree) => {
    let match;
    const visit = (node) => {
      if (!node || typeof node !== 'object' || match) return;
      if (predicate(node)) match = node;
      node.children?.forEach(visit);
    };
    visit(root);
    return match;
  };

  const findAll = (predicate, root = tree) => {
    const matches = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) matches.push(node);
      node.children?.forEach(visit);
    };
    visit(root);
    return matches;
  };

  const findButton = (label) => find((node) => node.type === 'button' && (node.children?.includes(label) || node.children?.some(c => typeof c === 'string' && c.includes(label))));

  return { render, find, findAll, findButton, slots };
}

test('DownloadManager displays merge queue status for pending and running tasks', async () => {
  const api = {
    getDownloadTasks: async () => [],
    getSeriesList: async () => [{ series_id: 's1', series_title: '剧目A' }, { series_id: 's2', series_title: '剧目B' }],
    getMergeTasks: async () => [],
    getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }),
  };

  const mergeTasks = [
    { id: 'm1', seriesId: 's1', seriesTitle: '剧目A', status: 'running', stageText: '正在合并', done: 5, total: 10, progress: 50 },
    { id: 'm2', seriesId: 's2', seriesTitle: '剧目B', status: 'pending', stageText: '排队等待合并', done: 0, total: 8, progress: 0 },
  ];

  const ui = harnessDM(api, { mergeTasks });
  ui.render();

  // Find cards
  const cards = ui.findAll((node) => node.props?.className?.includes('merge-card'));
  assert.equal(cards.length, 2);

  const runningCard = cards.find((c) => c.props.className.includes('merge-running'));
  assert.ok(runningCard, 'should render running card');

  const pendingCard = cards.find((c) => c.props.className.includes('merge-pending'));
  assert.ok(pendingCard, 'should render pending card');

  // Verify pending card shows "排队等待合并" or "排队中"
  const pendingText = JSON.stringify(pendingCard);
  assert.ok(pendingText.includes('排队等待合并') || pendingText.includes('排队'));
});

test('DownloadManager supports batch merge triggering for multiple selected series', async () => {
  const mergeCalls = [];
  const api = {
    getDownloadTasks: async () => [],
    getSeriesList: async () => [
      { series_id: '101', series_title: '短剧一' },
      { series_id: '102', series_title: '短剧二' }
    ],
    getMergeTasks: async () => [],
    getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }),
    mergeSeries: async (sid, name, options) => {
      mergeCalls.push({ sid, name, options });
      return { success: true, id: 'm_' + sid, status: mergeCalls.length === 1 ? 'running' : 'pending' };
    },
  };

  const ui = harnessDM(api, {
    seriesList: [{ series_id: '101', series_title: '短剧一' }, { series_id: '102', series_title: '短剧二' }]
  });
  ui.render();

  // Open merge dialog
  const mergeBtn = ui.findButton('合并整部剧');
  assert.ok(mergeBtn, 'Merge button should exist and be enabled');
  mergeBtn.props.onClick();
  ui.render();

  // Find checkboxes in merge dialog
  const checkboxes = ui.findAll((node) => node.type === 'input' && node.props?.type === 'checkbox');
  assert.ok(checkboxes.length >= 2, 'Should have checkboxes for series');

  // Check the second series as well
  checkboxes[1].props.onChange({ target: { checked: true } });
  ui.render();

  // Click "智能快速合并"
  const fastMergeBtn = ui.findButton('智能快速合并');
  assert.ok(fastMergeBtn, 'Should find fast merge button');
  await fastMergeBtn.props.onClick();
  await tick();

  assert.equal(mergeCalls.length, 2, 'Should submit merge for both selected series');
  assert.equal(mergeCalls[0].sid, '101');
  assert.equal(mergeCalls[1].sid, '102');
});

test('DownloadManager queues next series without submitting already running series', async () => {
  const mergeCalls = [];
  const api = {
    getDownloadTasks: async () => [],
    getSeriesList: async () => [
      { series_id: '101', series_title: '短剧一' },
      { series_id: '102', series_title: '短剧二' }
    ],
    getMergeTasks: async () => [],
    getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }),
    mergeSeries: async (sid, name, options) => {
      mergeCalls.push({ sid, name, options });
      return { success: true, id: 'm_' + sid, status: 'pending', count: 50 };
    },
  };

  const runningTasks = [
    { id: 'm_101', seriesId: '101', seriesTitle: '短剧一', status: 'running', stageText: '正在合并', done: 5, total: 50, progress: 10 }
  ];

  const ui = harnessDM(api, {
    seriesList: [{ series_id: '101', series_title: '短剧一' }, { series_id: '102', series_title: '短剧二' }],
    mergeTasks: runningTasks,
  });
  ui.render();

  // Toolbar should indicate active/pending merge
  const selectNode = ui.find(n => n.type === 'select' && n.props?.className?.includes('merge-select'));
  assert.ok(selectNode, 'Select should exist');

  // Open merge dialog
  const mergeBtn = ui.findButton('合并整部剧');
  assert.ok(mergeBtn, 'Merge button should exist');
  mergeBtn.props.onClick();
  ui.render();

  // In dialog, short drama 1 is queued so it should be disabled
  const checkboxes = ui.findAll(n => n.type === 'input' && n.props?.type === 'checkbox');
  assert.equal(checkboxes[0].props.disabled, true, 'Running task checkbox should be disabled');
  assert.equal(checkboxes[1].props.disabled, false, 'Unqueued task checkbox should not be disabled');

  // Short drama 2 should be automatically selected
  assert.equal(checkboxes[1].props.checked, true, 'Unqueued task should be preselected');

  // Submit fast merge
  const fastMergeBtn = ui.findButton('智能快速合并');
  assert.ok(fastMergeBtn);
  await fastMergeBtn.props.onClick();
  await tick();

  // Only Drama 2 should be submitted
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].sid, '102');
});

test('Settings page renders auto-retry interval input with default 600 seconds and saves update', async () => {
  let savedSettings = null;
  const api = {
    getSettings: async () => ({
      max_concurrent: 3,
      auto_retry_interval: 600,
    }),
    saveSettings: async (settings) => {
      savedSettings = settings;
      return { success: true };
    },
  };

  let cursor = 0, tree;
  const slots = [], effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = initial;
      return [slots[at], (value) => {
        slots[at] = typeof value === 'function' ? value(slots[at]) : value;
      }];
    },
    useRef(initial) {
      const at = cursor++;
      return slots[at] ||= { current: initial };
    },
    useEffect(effect, deps) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        slots[at] = { deps };
        effects.push(() => { slots[at].cleanup = effect(); });
      }
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  const icon = (props) => ({ type: 'icon', props: props || {}, children: [] });
  const dummyComp = () => ({ type: 'div', props: {}, children: [] });
  const module = { exports: {} };
  const require = (id) =>
    id === 'react' ? react
    : id === './danmakuSource.mjs' ? { useDanmakuSource: () => 'official', writeDanmakuSource: () => {} }
    : id === './useDialogKeyboard' ? () => {}
    : id === './Settings.css' ? {}
    : id === './AppearanceSettings' ? dummyComp
    : id === './ShortcutSettings' ? dummyComp
    : id === './CustomSources' ? dummyComp
    : id === './BuiltinSources' ? dummyComp
    : id === './AnnouncementSettings' ? dummyComp
    : id === './icons' ? new Proxy({}, { get: () => icon })
    : undefined;

  vm.runInNewContext(settingsCode, {
    module,
    exports: module.exports,
    require,
    window: { electronAPI: api },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  // pre-populate slot 0 (settings)
  slots[0] = {
    max_concurrent: 3,
    auto_retry_interval: 600,
  };

  const render = () => {
    cursor = 0;
    tree = module.exports.default({ active: true });
    while (effects.length) effects.shift()();
    return tree;
  };

  const find = (predicate, root = tree) => {
    let match;
    const visit = (node) => {
      if (!node || typeof node !== 'object' || match) return;
      if (predicate(node)) match = node;
      node.children?.forEach(visit);
    };
    visit(root);
    return match;
  };

  render();

  const retryInput = find((node) => node.type === 'input' && node.props?.id === 'auto-retry-interval');
  assert.ok(retryInput, 'Retry interval input should be rendered');
  assert.equal(retryInput.props.value, 600, 'Default retry interval should be 600');

  // Change to 300 seconds
  retryInput.props.onChange({ target: { value: '300' } });
  render();

  // Find save button
  const saveBtn = find((node) => node.type === 'button' && (node.children?.includes('保存') || node.children?.includes('已保存')));
  assert.ok(saveBtn, 'Save button should exist');
  await saveBtn.props.onClick();
  await tick();

  assert.ok(savedSettings, 'Settings should be persisted');
  assert.equal(savedSettings.auto_retry_interval, 300);
});

test('DownloadManager displays waiting retry countdown when task has retryAt', async () => {
  const api = {
    getDownloadTasks: async () => [],
    getSeriesList: async () => [],
    getMergeTasks: async () => [],
    getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }),
  };

  const tasks = [
    {
      id: 't_fail',
      title: '第1集',
      status: 'failed',
      error: '网络超时',
      retryAt: Date.now() + 45000, // 45 seconds in future
    },
  ];

  const ui = harnessDM(api, { tasks });
  ui.render();

  const text = JSON.stringify(ui.find((n) => n.props?.className?.includes('dm-task')));
  assert.ok(text.includes('等待重试'), 'Should render 等待重试 status tag');
  assert.ok(text.includes('秒后排队'), 'Should display seconds countdown');
  assert.ok(!text.includes('/3'), 'Should not show /3 when sourceRetries is undefined');
});


