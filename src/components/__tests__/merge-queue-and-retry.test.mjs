import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { formatMessage } from '../../i18n/translator.mjs';

const i18nMock = { t: formatMessage, useLanguage: () => 'zh-CN:zh-CN', getLanguage: () => 'zh-CN' };

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
    id === '../i18n' ? i18nMock
    : id === 'react' ? react
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
    id === '../i18n' ? i18nMock
    : id === 'react' ? react
    : id === './danmakuSource.mjs' ? { useDanmakuSource: () => 'official', writeDanmakuSource: () => {} }
    : id === './useDialogKeyboard' ? () => {}
    : id === './Settings.css' ? {}
    : id === './AppearanceSettings' ? dummyComp
    : id === './ShortcutSettings' ? dummyComp
    : id === './StealthWakeRegion.jsx' ? dummyComp
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
test('main.js backend enforces auto_retry_interval, skips fatal/source rejections, and manages batch merge queue', async (t) => {
  const { EventEmitter } = await import('node:events');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../main.js');
  const req = createRequire(mainPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-mqr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const handlers = {};
  const app = new EventEmitter();
  let settings = { root, auto_retry_interval: 5 };
  let savedTasks = [];
  let savedMerges = [];
  const intervals = [];
  const resolveFns = [];

  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => root,
    getLocale: () => 'zh-CN',
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }),
    quit() {},
  });

  const electron = {
    app,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} },
    Menu: { buildFromTemplate: items => items, setApplicationMenu() {} },
    dialog: { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) },
    session: { defaultSession: { setProxy: async () => {} } },
    shell: { showItemInFolder() {}, openPath: async () => '' },
  };
  const store = {
    init() {},
    setErrorHandler() {},
    getSettings: () => ({ ...settings }),
    saveSettings: s => { settings = { ...s }; },
    getTasks: () => JSON.parse(JSON.stringify(savedTasks)),
    saveTasks: tasks => { savedTasks = JSON.parse(JSON.stringify(tasks)); },
    getSeries: () => [],
    saveSeries() {},
    getMergeTasks: () => JSON.parse(JSON.stringify(savedMerges)),
    saveMergeTasks: tasks => { savedMerges = JSON.parse(JSON.stringify(tasks)); },
  };

  let now = 1_000_000;
  class FakeDate extends Date {
    static now() { return now; }
  }

  const mergeRunner = {
    stopMergeChildren() {},
    runMerge: async ({ task }) => {
      await new Promise((resolve) => resolveFns.push({ id: task.id, resolve, task }));
      if (!task.cancelled) task.status = 'completed';
    },
  };

  const ctx = vm.createContext({
    require: (name) => name === 'electron' ? electron
      : name === './src/store' ? store
      : name === './src/native/merge-runner' ? mergeRunner
      : req(name),
    __dirname: path.dirname(mainPath),
    process,
    Buffer,
    URL,
    Response,
    Request,
    Headers,
    AbortController,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    setImmediate,
    setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; },
    clearInterval: () => {},
    console: { log() {}, warn() {}, error() {} },
  });

  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), ctx, { filename: mainPath });
  req('./scripts/fixtures/trusted-ipc.cjs')(ctx, handlers);
  const run = (code) => vm.runInContext(code, ctx);

  // Stub filesystem/ffmpeg/pumpQueue for merge queue and retry tests
  const epA = path.join(root, 'A1.mp4');
  const epB = path.join(root, 'B1.mp4');
  const epC = path.join(root, 'C1.mp4');
  fs.writeFileSync(epA, 'aaa');
  fs.writeFileSync(epB, 'bbb');
  fs.writeFileSync(epC, 'ccc');
  run(`
    pumpQueue = () => {};
    resolveFfmpeg = () => '/fixture/ffmpeg';
    collectSeriesEpisodeFiles = (sid) => ({
      dir: ${JSON.stringify(root)},
      ordered: [{ path: sid === 'A' ? ${JSON.stringify(epA)} : sid === 'B' ? ${JSON.stringify(epB)} : ${JSON.stringify(epC)}, vid_index: 1 }],
    });
  `);

  // Part 1: fatal vs recoverable failure checks + tickAutoRetry
  run(`
    downloadTasks = [
      { id: 'rec', status: 'failed', endTime: 1000000, error: '临时断网' },
      { id: 'app_rej', status: 'failed', endTime: 1000000, error: '取源失败', errorCode: 'SOURCE_UNAVAILABLE', errorSources: [{ source: 'app', code: 'BUSINESS_REJECTED' }] },
      { id: 'sec_blk', status: 'failed', endTime: 1000000, error: '被拦截', errorCode: 'SOURCE_UNAVAILABLE', errorSources: [{ source: 'web', code: 'SECURITY_BLOCKED' }] },
      { id: 'disk_full', status: 'failed', endTime: 1000000, error: '写入失败', errorCode: 'EPERM' },
      { id: 'user_stop', status: 'failed', endTime: 1000000, error: '用户已暂停', cancelled: true },
    ];
    setupAutoRetryTimer();
  `);

  assert.equal(ctx.isFatalDownloadFailure(run('downloadTasks[0]')), false);
  assert.equal(ctx.isFatalDownloadFailure(run('downloadTasks[1]')), true);
  assert.equal(ctx.isFatalDownloadFailure(run('downloadTasks[2]')), true);
  assert.equal(ctx.isFatalDownloadFailure(run('downloadTasks[3]')), true);
  assert.equal(ctx.isFatalDownloadFailure(run('downloadTasks[4]')), true);
  assert.equal(run('downloadTasks[0].retryAt'), 1_005_000, 'recoverable task should get retryAt = now + 5s');
  assert.equal(run('downloadTasks[1].retryAt'), undefined, 'app BUSINESS_REJECTED must never schedule auto-retry');
  assert.equal(run('downloadTasks[2].retryAt'), undefined, 'SECURITY_BLOCKED must never schedule auto-retry');
  assert.equal(run('downloadTasks[3].retryAt'), undefined, 'EPERM must never schedule auto-retry');

  // Advance clock past 5s and tickAutoRetry -> rec rejoins downloadQueue as pending
  now = 1_006_000;
  ctx.tickAutoRetry();
  assert.equal(run('downloadTasks[0].status'), 'pending');
  assert.equal(run('downloadTasks[0].retryAt'), undefined);
  assert.equal(run('downloadQueue.some(item => item.id === "rec")'), true);

  // Disabling auto_retry_interval = 0 clears generic pending retryAt without killing bounded source retries
  run(`
    downloadTasks.push({ id: 'rec2', status: 'failed', endTime: ${now}, retryAt: ${now + 10_000}, error: 'neterr' });
    downloadTasks.push({ id: 'src1', status: 'failed', endTime: ${now}, retryAt: ${now + 10_000}, sourceRetries: 1, error: 'timeout' });
  `);
  const disableRes = await handlers['save-settings']({}, { auto_retry_interval: 0 });
  assert.equal(disableRes.success, true);
  assert.equal(run('downloadTasks.find(item => item.id === "rec2").retryAt'), undefined);
  assert.ok(run('downloadTasks.find(item => item.id === "src1").retryAt'), 'bounded source retry stays scheduled');

  // Part 2: sequential batch merge queue + cancel pending + delete guard
  const m1 = await handlers['merge-series']({}, 'A', 'SeriesA', { compatible: false });
  const m2 = await handlers['merge-series']({}, 'B', 'SeriesB', { compatible: false });
  const mCancel = await handlers['merge-series']({}, 'C', 'SeriesC', { compatible: false });
  assert.equal(m1.success, true);
  assert.equal(m1.status, 'running');
  assert.equal(m2.success, true);
  assert.equal(m2.status, 'pending');
  assert.equal(mCancel.success, true);
  assert.equal(mCancel.status, 'pending');

  // Cancel queued mCancel cleanly while A runs and B stays queued
  const cancelRes = await handlers['cancel-merge']({}, mCancel.id);
  assert.equal(cancelRes.success, true);
  assert.equal(run(`mergeTasks.find(m => m.id === ${JSON.stringify(mCancel.id)}).status`), 'stopped');

  // Deletion must be blocked while B has a pending merge
  const delB = await handlers['delete-series-files']({}, 'B');
  assert.equal(delB.success, false);
  assert.match(delB.error, /正在合并/);

  // Complete first merge -> setImmediate/pumpMergeQueue should auto-start second merge
  assert.equal(resolveFns.length, 1);
  assert.equal(resolveFns[0].id, m1.id);
  resolveFns[0].resolve();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(resolveFns.length, 2, 'second merge task should auto-start after first completes');
  assert.equal(resolveFns[1].id, m2.id);
  assert.equal(run(`mergeTasks.find(m => m.id === ${JSON.stringify(m2.id)}).status`), 'running');

  // Finish second merge cleanly so no timers/tasks linger
  resolveFns[1].resolve();
  await new Promise((r) => setTimeout(r, 30));

  // Verify quit cancels pending merge tasks cleanly
  const m3 = await handlers['merge-series']({}, 'A', 'SeriesA_q1', { compatible: false });
  const m4 = await handlers['merge-series']({}, 'B', 'SeriesB_q2', { compatible: false });
  assert.equal(m3.status, 'running');
  assert.equal(m4.status, 'pending');
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(run(`mergeTasks.find(m => m.id === ${JSON.stringify(m4.id)}).status`), 'stopped');
  assert.equal(run(`mergeTasks.find(m => m.id === ${JSON.stringify(m4.id)}).error`), '应用关闭时中断');
  resolveFns.at(-1).task.cancelled = true;
  resolveFns.at(-1).resolve();
  await new Promise((r) => setTimeout(r, 30));
});
