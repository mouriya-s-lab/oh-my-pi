# 进程身份

```vdm
module Governance
exports
  types Identity
definitions
types
  -- 一个进程的身份：只有进程号与出生标记都相同才是同一个进程；起源进程的身份同时是以它为根的受管进程树的身份
  Identity ::
    pid   : nat    -- 操作系统分配的进程号，会被复用
    birth : token; -- 这个进程出生时刻的标记，由平台给出，区分复用同一进程号的先后进程
end Governance
```
