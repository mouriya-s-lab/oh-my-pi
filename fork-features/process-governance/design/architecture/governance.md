# 进程身份

```vdm
module Governance
exports
  types
    struct Identity
definitions
types
  -- 一个进程的身份：进程号加出生标记；对 Spawn 起的根进程，它同时是那棵受管进程树的身份
  Identity ::
    pid   : nat    -- 操作系统分配的进程号
    birth : token; -- 这个进程出生时刻的标记，由平台给出
end Governance
```
