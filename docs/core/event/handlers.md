# 处理器注册、排序与版本隔离

本页详细说明 `apix.core.event.handler_registry` 的用户级行为。

## subscribe()

```python
subscribe(
    *event_names: str,
    exist_ok: bool = True,
    priority: float | None = None,
    between_handlers: tuple[str | None, str | None] | None = None,
    filter_event: list[str] | None = None,
    stop_when_error: bool = True,
    time_out: float | None = None,
    background: bool = False,
)
```

装饰器接受异步函数或 `ApixEventHandler` 实例，并原样返回被装饰对象。`core_func`、`on_has_error` 和 `on_accepted` 接收 `ApixEvent`；`on_error` 接收 `(event, exception)`。所有回调均为异步函数，返回 `None`。

```python
from apix.core.event import ApixEvent, subscribe


@subscribe("agent.*", priority=10)
async def observe_agent_event(event: ApixEvent) -> None:
    print(event.event_name)
```

### 参数

| 参数 | 行为 |
| --- | --- |
| `event_names` | 一个或多个精确名称或 glob 模式；不能为空 |
| `exist_ok` | 同名函数已存在时是否忽略本次注册；去重依据仅为函数名 |
| `priority` | 数值越大越先执行；同优先级保持注册顺序；默认 `1` |
| `between_handlers` | 按已注册函数名将新处理器插入指定边界；不能与 `priority` 同用 |
| `filter_event` | 在订阅命中后继续排除的 glob 模式 |
| `stop_when_error` | 事件已有错误时是否跳过当前 handler 的核心函数；不跳过通知 |
| `time_out` | 每个实际调用的回调分别限时；`None` 或非正数表示无限等待 |
| `background` | 是否创建后台任务并立即继续分发 |

## 带通知的处理器

```python
from apix.core.event import ApixEvent, ApixEventHandler, subscribe


async def process_request(event: ApixEvent) -> None:
    # Own failures must be handled here when local recovery is needed.
    print("process", event.context)


async def handle_upstream_error(event: ApixEvent) -> None:
    # Release resources or complete pending futures owned by this handler.
    for error in event.error_stack:
        print(error.handler_name, error.phase, error.message)


async def handle_accepted(event: ApixEvent) -> None:
    print("request already accepted", event.event_id)


async def handle_own_error(event: ApixEvent, error: Exception) -> None:
    # Handle this handler's own failure using the original exception.
    print("own failure", event.event_id, type(error).__name__, str(error))


request_handler: ApixEventHandler = subscribe("request.*", time_out=5)(
    ApixEventHandler(
        process_request,
        on_accepted=handle_accepted,
        on_has_error=handle_upstream_error,
        on_error=handle_own_error,
    )
)
```

`request_handler` 仍是原实例；`await request_handler(event)` 等价于 `await request_handler.execute(event)`。处理器使用 `core_func.__name__` 作为注册名。

`subscribe()` 的参数（**包括默认值**）覆盖实例中的同名配置，保留通知回调。例如，实例设置 `background=True`，但装饰器传该参数为 `False`，则注册后实例的该值为 `False`。实例设置 `background=True`，但装饰器未传该参数，则注册后该实例值保持为 `True`。重复名称且 `exist_ok=True` 时直接忽略注册，不修改已有实例。

执行规则如下：

| 事件状态 | 当前 handler 行为 |
| --- | --- |
| 无错误，未 accepted | 调用 `core_func` |
| 已有错误，未 accepted，`stop_when_error=True` | 调用 `on_has_error`，跳过 `core_func` |
| 已有错误，未 accepted，`stop_when_error=False` | 调用 `on_has_error`，然后调用 `core_func` |
| 无错误，已 accepted | 调用 `on_accepted`，跳过 `core_func` |
| 已有错误，已 accepted | 依次调用 `on_has_error`、`on_accepted`，跳过 `core_func` |
| 已有错误，调用 `on_has_error` 过程中 accepted | 依次调用 `on_has_error`、`on_accepted`，跳过 `core_func` |

未设置的通知直接跳过。错误通知执行后会重新检查事件状态，因此通知中调用 `accept()` 也会阻止核心函数执行。每次 `execute()` 内同一种通知最多执行一次。

核心函数自己的异常不会触发自己的 `on_has_error`；核心函数自己调用 `accept()` 也不会回调自己的 `on_accepted`。这些状态供之后的 handler 处理。

### 当前 handler 的 on_error

```python
ApixEventHandler(
    core_func,
    on_accepted=None,
    on_has_error=None,
    on_error=None,
    stop_when_error=True,
    time_out=None,
    background=False,
)
```

`on_error` 的类型为 `EventHandlerErrorFunc = Callable[[ApixEvent, Exception], Awaitable[None]]`，可从 `apix.core.event` 导入。

- `core_func`、`on_has_error`、`on_accepted` 中任何一个抛出未捕获异常或超时，都先记录错误，再调用 `on_error(event, exception)`；第二个参数是原始异常对象。
- `on_error` 成功返回不会移除已记录的错误，也不会重试失败的函数。后续 handler 仍可通过 `on_has_error` 感知该失败。
- 每次回调失败只调用一次 `on_error`。一次 `execute()` 内若多个回调依次失败，分别通知；`on_error` 自身失败则只记录 `phase="on_error"` 的错误信息在 `event.error_stack` 堆栈，不递归调用。
- `time_out` 也独立应用于 `on_error`。任务取消继续传播，不调用 `on_error`，也不追加业务错误记录。
- 后台 handler 同样调用 `on_error`，但原始错误和 `on_error` 自身错误都仅写日志，不写入事件错误栈。显式修改事件或业务上下文仍是回调自身的行为。
- `subscribe()` 保留实例上的 `on_error`。若业务希望自行捕获并恢复异常而不留下事件失败记录，应继续在原函数内使用 `try/except/finally`。

## 匹配语义

订阅和过滤均使用 `fnmatch.fnmatchcase`，因此：

- 匹配大小写敏感。
- `*` 匹配任意数量字符。
- `?` 匹配一个字符。
- `[abc]` 匹配集合内的一个字符。
- `[a-z]` 匹配字符范围。
- `[!abc]` 匹配不在集合中的一个字符。
- 点号 `.`、斜杠 `/` 没有特殊的路径分隔语义，`*` 可以跨越它们。

```python
@subscribe(
    "graph.*",
    filter_event=["graph.internal.*", "graph.debug.??"],
)
async def observe_public_graph_events(event: ApixEvent) -> None:
    ...
```

该处理器会接收 `graph.started`，不会接收 `Graph.started` 或 `graph.internal.snapshot`。

重复模式会按首次出现顺序去重。

## 优先级排序

默认排序规则为：

1. 优先级较大的处理器先执行。
2. 相同优先级内按注册顺序执行。

```python
@subscribe("order.created", priority=20)
async def validate_order(event: ApixEvent) -> None:
    ...


@subscribe("order.created", priority=10)
async def persist_order(event: ApixEvent) -> None:
    ...
```

`validate_order` 会先于 `persist_order` 执行。

`priority` 必须是有限数值，不能是 `bool`、`NaN` 或无穷大。

## 显式插入位置

当插件需要相对于已有处理器插入，而不是猜测对方的优先级时，可使用 `between_handlers`。

### 插入到右侧处理器之前

```python
@subscribe(
    "order.*",
    between_handlers=(None, "persist_order"),
)
async def enrich_order(event: ApixEvent) -> None:
    ...
```

### 插入到左侧处理器之后

```python
@subscribe(
    "order.*",
    between_handlers=("validate_order", None),
)
async def audit_validated_order(event: ApixEvent) -> None:
    ...
```

### 插入到两个边界之间

```python
@subscribe(
    "order.*",
    between_handlers=("validate_order", "persist_order"),
)
async def normalize_order(event: ApixEvent) -> None:
    ...
```

两个边界都存在时，新处理器紧邻右边界之前插入；原本位于左右边界之间的处理器仍在新处理器之前。

约束：

- 边界使用处理器函数名，不是事件名或 handler id。
- 边界处理器必须仍处于 active 状态。
- `(None, None)` 无效。
- 左右边界不能相同。
- 左边界必须本来就排在右边界之前。
- `between_handlers` 与显式 `priority` 不能同时提供。

## 发布时版本隔离

处理器链并不是消费事件时才首次决定。事件进入本地 `builtin` 队列时，`ApixEventPipe` 会：

1. 为该精确事件名解析当前处理器链；
2. 将链的版本号写入事件；
3. 再把事件放入队列。

因此，事件发布之后发生的注册、部分注销或全部注销，不会改变该事件已经冻结的处理器顺序。

```python
await EVENT_PIPE.post_event(
    event_type=EventType.INFO,
    event_name="task.ready",
)

# This handler only affects events published after registration.
@subscribe("task.ready", priority=100)
async def late_handler(event: ApixEvent) -> None:
    ...
```

处理器链按精确事件名懒解析和缓存。注册一个宽泛通配符不会预热所有已观察事件，也不会为未知事件枚举名称。

## 后台处理器

```python
@subscribe(
    "audit.*",
    background=True,
    time_out=5,
)
async def write_audit_log(event: ApixEvent) -> None:
    ...
```

后台处理器的行为：

- 分发器创建任务后立即继续处理下一个 handler。
- 后台任务之间最多并发 100 个。
- 核心函数和通知函数的未捕获异常、超时只记录日志，不写入事件 `error_stack`。
- `stop_when_error` 决定当前后台 handler 是否因已存在的前台错误跳过核心函数。
- 在实际执行时检查 `has_error` 和 `accepted`，不会为已经执行结束的 handler 补发通知。
- 后续前台处理器调用 `event.accept()` 时，已经开始的后台任务不会被取消。

如果处理器必须在下一个处理器之前完成，不要设置 `background=True`。

## 注销与删除

### 部分注销

```python
unsubscribe(
    "observe_agent_event",
    ["agent.internal.*"],
)
```

部分注销会把模式加入处理器的 `filter_event`，处理器仍然 active，并继续接收其他订阅事件。

### 全部注销

```python
unsubscribe("observe_agent_event")
```

全部注销会把处理器从 active 排序桶移除，但保留 registry entry。保留 entry 是为了让已经发布、绑定了旧链版本的事件仍能解析到原处理器。

### 永久删除

```python
delete_handler_from_registry("observe_agent_event")
```

永久删除会移除处理器 entry 和 active 排序引用。它适合插件卸载或图 `decompose()` 后的最终清理。

注意：如果仍有绑定旧版本的事件在队列中，永久删除可能导致旧链中的处理器名无法解析；分发器会记录警告并跳过该处理器。因此，在可能存在排队事件时优先使用 `unsubscribe()`，待生命周期结束后再永久删除。

两个函数都默认 `missing_ok=True`。需要严格检查时：

```python
unsubscribe("required_handler", missing_ok=False)
delete_handler_from_registry("required_handler", missing_ok=False)
```

## 注册诊断

### 读取元数据

```python
meta = get_handler_meta("observe_agent_event")
```

返回字段包括：

```python
{
    "id": "handler-...",
    "name": "observe_agent_event",
    "register_order": 0,
    "subscribe": ["agent.*"],
    "filter_event": [],
    "priority": 10,
    "between_handlers": None,
    "stop_when_error": True,
    "time_out": None,
    "background": False,
}
```

处理器不存在时返回 `None`。

### 找出尚未匹配的订阅

```python
patterns = get_unmatched_subscriptions("observe_agent_event")
```

该结果基于 `APIX_EVENT_REGISTRY` 已观察到的精确事件名。应用刚启动、尚未发布事件时，所有订阅模式都可能被报告为 unmatched。

## 低级数据模型与 Registry API

大多数应用应使用模块级 `subscribe()`、`unsubscribe()` 和 `delete_handler_from_registry()`。框架扩展或诊断工具也可以直接使用 `ApixEventHandler` 与 `ApixHandlerRegistry`。

### ApixEventHandler

```python
from apix.core.event import ApixEventHandler
```

该类封装核心函数和两个前置状态通知函数：

| 字段 | 说明 |
| --- | --- |
| `name` | 全局唯一处理器名 |
| `_register_order` | 内部注册顺序编号 |
| `core_func` | 异步核心处理函数 |
| `on_has_error` | 当前 handler 对前置错误的响应，可为 `None` |
| `on_accepted` | 当前 handler 对已 accepted 事件的响应，可为 `None` |
| `on_error` | 接收事件和当前 handler 自身的原始异常，可为 `None` |
| `id` | 自动生成的 `handler-...` 标识 |
| `subscribe` | 包含模式列表 |
| `filter_event` | 排除模式列表 |
| `priority` | 优先级；边界插入时为 `None` |
| `between_handlers` | 注册时指定的相对位置 |
| `stop_when_error` | 已有错误时是否跳过当前核心函数 |
| `time_out` | 每个实际调用的回调的超时时间 |
| `background` | 是否后台执行 |

构造函数只接收四个回调、`stop_when_error`、`time_out` 和 `background`；其余注册参数由全局 `subscribe()` 注入。底层 `register_handler(entry)` 要求 entry 已具备完整注册信息，负责验证模式、core_func、priority 和边界，并更新受影响的精确事件链版本。

### ApixHandlerRegistry

该类是进程级 singleton；新建 `ApixHandlerRegistry()` 得到的仍是全局同一实例。主要方法：

| 方法 | 说明 |
| --- | --- |
| `register_handler(entry)` | 注册一个完整 `ApixEventHandler` |
| `unregister_handler(name, event_names=None)` | 部分或全部停用，保留旧版本 entry |
| `delete_handler_from_registry(name, event_names=None)` | 永久删除 entry |
| `get_handler(name)` | 返回 entry 或 `None` |
| `get_handlers_chain_for_event(event_name, version=None)` | 获取精确事件某版本的处理器名顺序 |
| `get_current_version_for_event(event_name)` | 解析当前链并返回版本号 |
| `get_current_version_for_event_without_resolve(event_name)` | 仅查询已有缓存版本；未出现时返回 `None` |
| `get_unmatched_subscriptions(name)` | 返回未覆盖已观察事件的订阅模式 |

`registry`、`priority_buckets` 和 `cached_chain` 是可见的运行时结构，但应用不应直接修改，否则无法同步完成版本失效与旧事件隔离。

历史链 version 必须是从 0 开始的有效非负整数。与 GraphContext snapshot version 不同，handler chain API 不接受负索引。

## 插件清理模板

```python
from apix.core.event import (
    ApixEvent,
    delete_handler_from_registry,
    subscribe,
    unsubscribe,
)


class Plugin:
    def install(self) -> None:
        @subscribe("agent.*", exist_ok=False)
        async def plugin_agent_observer(event: ApixEvent) -> None:
            ...

        self.handler_name = plugin_agent_observer.__name__

    def disable(self) -> None:
        unsubscribe(self.handler_name)

    def uninstall(self) -> None:
        delete_handler_from_registry(self.handler_name)
```

处理器名在进程全局唯一。多个插件若可能定义同名函数，应给函数设置稳定且带插件前缀的 `__name__`，并使用 `exist_ok=False` 及时暴露冲突。
