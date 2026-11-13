/**
 * @boois/dsh-delete-sessions - 浏览器半区。
 *
 * 在侧栏每个会话的「…」菜单里加一个**红色**的「删除会话」项，位置在
 * 「归档会话」(order 400) 正下方、「复制 Session ID」(order 450) 之上（order 410）。
 *
 * 菜单项沿用宿主 MenuItemButton + Fluent 图标，并带 `danger: true` 让整行按
 * 宿主的危险色（`--dsw-alias-state-error-primary`）着色——与「删除工作区」
 * 走同一条路径，因此颜色/间距/字号天然一致。
 *
 * 确认对话框放在**`shell.overlay` 槽**，而不是菜单项组件内部：
 * 菜单项一旦被点击就会 `setMenuOpen(false)` 关闭菜单、整个组件随之卸载，
 * 若把 Modal 渲染在它里面，弹窗会刚出现就被销毁（这正是「点了没反应」的原因）。
 *
 * 相对上游 0.2.2 客户端的三点变化（详见 docs/AUDIT-0.2.2.md）：
 *   - 打开对话框先 `GET plan` 读取**影响面**：会话是否活动中、有哪些定时任务
 *     指向它（删了会被重建）、有多少子代理子会话会被连带删除；
 *   - 有定时任务命中时必须勾选「同时暂停这些任务」才会放开删除按钮，
 *     403/409 的机器可读原因直接显示给用户；
 *   - `<style>` 在模块工厂期注入（模块加载即注入，卸载不遗留），不再挂在
 *     对话框的 `useEffect` 上（上游那里卸载清理依赖装载器认领，升级后易残留）。
 *
 * 手写 CommonJS 形状的浏览器 bundle：`window.__ModuleLoader__.load({id, factory})`，
 * 模块 id 必须等于包名（装载器按 id 认领模块，
 * `@deepseek-ai/dsh-client-modules/lib/client.js:877`），scoped 包名受支持。
 *
 * @module @boois/dsh-delete-sessions/client
 */
window.__ModuleLoader__.load({
  id: '@boois/dsh-delete-sessions',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { MenuItemButton, Modal, Button, IconTrashOutlineRegular } = primitives;
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

    /** 宿主路由（同源）。 */
    const PLAN_PATH = '/plugins/@boois/dsh-delete-sessions/plan';
    const DELETE_PATH = '/plugins/@boois/dsh-delete-sessions/delete';

    /** 危险按钮 / 辅助文字样式类名。 */
    const PREFIX = 'boois-delete-sessions';
    const DANGER_BUTTON_CLASS = PREFIX + '-danger';
    const DIALOG_META_CLASS = PREFIX + '-meta';
    const PLAN_LIST_CLASS = PREFIX + '-plan';
    const STYLE_ID = PREFIX + '-style';

    /**
     * 模块工厂期注入样式：危险色取宿主自己的语义变量，跟随主题。
     * 只注入一次，且不在组件卸载时移除——模块由装载器长期持有。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', '@boois/dsh-delete-sessions');
      style.textContent = [
        '.' + DANGER_BUTTON_CLASS + ':not(:disabled){',
        '  color: var(--dsw-alias-state-error-primary);',
        '  border-color: var(--dsw-alias-state-error-primary);',
        '}',
        '.' + DANGER_BUTTON_CLASS + ':not(:disabled):hover{',
        '  background: var(--dsw-alias-state-error-primary);',
        '  color: var(--dsw-alias-label-on-primary, #fff);',
        '}',
        '.' + DIALOG_META_CLASS + '{',
        '  margin-top: 8px;',
        '  font-size: 12px;',
        '  line-height: 18px;',
        '  color: var(--dsw-alias-label-tertiary);',
        '  word-break: break-all;',
        '}',
        '.' + PLAN_LIST_CLASS + '{',
        '  margin-top: 12px;',
        '  padding: 8px 10px;',
        '  border-radius: 6px;',
        '  background: var(--dsw-alias-background-secondary, transparent);',
        '  font-size: 12px;',
        '  line-height: 18px;',
        '}',
        '.' + PLAN_LIST_CLASS + ' ul{margin:4px 0 0;padding-left:16px;}',
      ].join('\n');
      document.head.appendChild(style);
    }
    ensureStyle();

    /** 影响面摘要（plan 端点的返回值）。 */
    function PlanSummary({ plan }) {
      if (plan === null) {
        return React.createElement('div', { className: DIALOG_META_CLASS }, '正在读取影响面…');
      }
      const rows = [];
      // 能不能删取决于「有没有在跑的工作」；「实例驻留内存」只是可能被重建的
      // 风险提示。0.3.2 之前把 live 说成「正在运行」，空闲会话上也照这句显示。
      if (plan.active === true) {
        rows.push(React.createElement('li', { key: 'active' },
          '该会话有未结束的工作'
            + (Array.isArray(plan.activity) && plan.activity.length > 0 ? '（' + plan.activity.join('、') + '）' : '')
            + '：将先停止并等待其结束；限时内未结束则拒绝删除。'));
      } else if (plan.live === true) {
        rows.push(React.createElement('li', { key: 'live' },
          '该会话在宿主内存中仍驻留（通常是还有页面开着它），但没有在跑的工作：可以直接删除，删后建议刷新页面。'));
      } else {
        rows.push(React.createElement('li', { key: 'idle' }, '该会话未在运行。'));
      }
      if (Array.isArray(plan.children) && plan.children.length > 0) {
        rows.push(React.createElement('li', { key: 'children' },
          '将连带删除 ' + plan.children.length + ' 个子代理子会话（侧栏里看不到它们）。'));
      }
      if (Array.isArray(plan.childrenNotes) && plan.childrenNotes.length > 0) {
        rows.push(React.createElement('li', { key: 'childrenNotes' },
          '子会话清单可能不完整：' + plan.childrenNotes.join('；')));
      }
      const active = (plan.tasks ?? []).filter((task) => task.status === 'active');
      if (active.length > 0) {
        rows.push(React.createElement('li', { key: 'tasks' },
          '有 ' + active.length + ' 个定时任务指向该会话，删除前必须暂停它们：',
          React.createElement('ul', null, active.map((task) => React.createElement('li', { key: task.id },
            (task.title || task.id) + '（' + task.reasons.join('、') + '）')))));
      }
      return React.createElement('div', { className: PLAN_LIST_CLASS },
        React.createElement('div', null, '影响面'),
        React.createElement('ul', null, rows));
    }

    /**
     * 删除确认对话框（`shell.overlay` 的常驻宿主）。
     *
     * `useDeleteRequest` 由槽的 `hooks: { deleteRequest }` 注入；没有待确认
     * 请求时返回 null，因此它不占用界面，也不会随会话菜单开关而卸载。
     */
    function DeleteSessionDialog({ useDeleteRequest, dismissDeleteRequest }) {
      const request = useDeleteRequest((pending) => pending);
      const [plan, setPlan] = React.useState(null);
      const [confirmTasks, setConfirmTasks] = React.useState(false);
      const [deleting, setDeleting] = React.useState(false);
      const [error, setError] = React.useState(null);

      const sessionId = request === null ? null : request.sessionId;

      // 换一个待确认会话（或关闭）时，清掉上一次的进行中/错误状态并重新预检。
      React.useEffect(() => {
        setPlan(null);
        setConfirmTasks(false);
        setDeleting(false);
        setError(null);
        if (sessionId === null) return;
        let cancelled = false;
        fetch(PLAN_PATH + '?sessionId=' + encodeURIComponent(sessionId), {
          method: 'GET',
          credentials: 'same-origin',
        })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (cancelled) return;
            if (!response.ok || data.ok !== true) {
              setError((data && data.error) ? data.error : ('预检失败：HTTP ' + response.status));
              return;
            }
            setPlan(data);
          })
          .catch((thrown) => {
            if (!cancelled) setError(thrown && thrown.message ? thrown.message : String(thrown));
          });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);

      if (request === null) return null;

      const title = (request.displayTitle && String(request.displayTitle).trim() !== '')
        ? String(request.displayTitle)
        : sessionId;

      const activeTasks = plan === null ? [] : (plan.tasks ?? []).filter((task) => task.status === 'active');
      const needsTaskConfirm = activeTasks.length > 0;
      const ready = plan !== null && error === null && (!needsTaskConfirm || confirmTasks);

      const close = () => {
        if (deleting) return;
        dismissDeleteRequest();
      };

      const confirm = () => {
        if (deleting || !ready) return;
        setDeleting(true);
        setError(null);
        fetch(DELETE_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, confirmTasks: needsTaskConfirm ? confirmTasks : undefined }),
        })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.ok !== true) {
              const parts = [];
              if (data && data.error) parts.push(data.error);
              else parts.push('HTTP ' + response.status);
              if (Array.isArray(data.failures) && data.failures.length > 0) parts.push(data.failures.join('; '));
              if (Array.isArray(data.warnings) && data.warnings.length > 0) parts.push('告警：' + data.warnings.join('; '));
              setError(parts.join(' — '));
              setDeleting(false);
              return;
            }
            // 成功：宿主广播 api-session/removed，行自动卸载；这里收起对话框。
            dismissDeleteRequest();
          })
          .catch((thrown) => {
            setError(thrown && thrown.message ? thrown.message : String(thrown));
            setDeleting(false);
          });
      };

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        closeLabel: '关闭',
        title: '删除会话',
        footer: React.createElement(React.Fragment, null,
          React.createElement(Button, {
            variant: 'outline',
            disabled: deleting,
            onClick: close,
            children: '取消',
          }),
          React.createElement(Button, {
            variant: 'outline',
            className: DANGER_BUTTON_CLASS,
            disabled: !ready || deleting,
            onClick: confirm,
            children: deleting ? '删除中…' : '永久删除（不可撤销）',
          })),
        children: [
          React.createElement('div', { key: 'desc' },
            '将永久删除该会话及其全部对话记录（会话日志文件、投影缓存、spill 临时文件与工作区记账），此操作不可撤销，也不是安全擦除。'),
          React.createElement(PlanSummary, { key: 'plan', plan }),
          needsTaskConfirm ? React.createElement('label', {
            key: 'tasks-confirm',
            className: DIALOG_META_CLASS,
            style: { display: 'flex', gap: 6, alignItems: 'flex-start' },
          },
            React.createElement('input', {
              type: 'checkbox',
              checked: confirmTasks,
              onChange: (event) => setConfirmTasks(event.target.checked),
            }),
            React.createElement('span', null, '我已确认：同时暂停上面这些定时任务（不会删除任务本身），否则它们会把该会话连同历史 prompt 重建。')) : null,
          React.createElement('div', { key: 'title', className: DIALOG_META_CLASS },
            '会话：' + title),
          React.createElement('div', { key: 'id', className: DIALOG_META_CLASS },
            '序列号：' + sessionId),
          error === null ? null : React.createElement('div', {
            key: 'err',
            className: DIALOG_META_CLASS,
            style: { color: 'var(--dsw-alias-state-error-primary)' },
            role: 'alert',
          }, '未完成：' + error),
        ],
      });
    }

    /**
     * 会话「…」菜单里的「删除会话」项（红色）。
     *
     * 只负责收起菜单并把请求交给插件级 store——对话框由 `shell.overlay`
     * 里的常驻组件渲染，所以菜单关闭不会把弹窗一起带走。
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, deleteRequest }) {
      const [, setMenuOpen] = useMenuOpenState ? useMenuOpenState() : [null, () => {}];

      const onSelect = () => {
        setMenuOpen(false);
        deleteRequest.set({ sessionId, displayTitle: displayTitle ?? null });
      };

      return React.createElement(MenuItemButton, {
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        danger: true,
        onSelect,
        children: '删除会话',
      });
    }

    /** 注册菜单项与浮层对话框；slots 服务缺失时显式告警（不静默降级）。 */
    function apply(ctx) {
      try {
        const slots = ctx.get ? ctx.get('slots') : undefined;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          if (typeof console !== 'undefined') console.warn('[@boois/dsh-delete-sessions] slots unavailable, entries not registered');
          return;
        }

        /**
         * 待确认的删除请求。用宿主的 snapshot store（而不是组件 state），
         * 让「菜单项」与「浮层对话框」两个互不相关的组件共享同一份状态；
         * 它活在插件作用域里，菜单开关不影响它。
         */
        const deleteRequest = createSnapshotStore(null);

        // order 410：恰在「归档会话」(400) 之下、「复制 Session ID」(450) 之上。
        slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'delete-session',
            order: 410,
            inject: () => ({ deleteRequest }),
          }, DeleteSessionMenuItem);
        });

        // 常驻浮层：菜单项卸载后对话框仍然存在。
        slots.inject('shell.overlay', function* () {
          yield slots.register({
            name: 'shell.overlay',
            id: 'boois-delete-sessions-confirm',
            inject: () => ({
              hooks: { deleteRequest },
              dismissDeleteRequest: () => deleteRequest.set(null),
            }),
          }, DeleteSessionDialog);
        });

        if (typeof console !== 'undefined') console.info('[@boois/dsh-delete-sessions] client half active');
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[@boois/dsh-delete-sessions] failed to register entries', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
