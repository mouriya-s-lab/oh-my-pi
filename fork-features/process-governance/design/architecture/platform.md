# 平台连接

```vdm
module Platform
exports
  types
    struct Identity; struct Guarantee; struct Capability; Enclosure; struct Opened; struct OpenOutcome;
    Program; struct SpawnOutcome; struct Usage
  functions
    Zero: () -> Usage;
    Add: Usage * Usage -> Usage;
    Total: set of Identity * map Identity to Usage -> Usage
  operations
    Open: [Enclosure] ==> OpenOutcome;
    Spawn: Program * [Enclosure] ==> SpawnOutcome;
    Members: Enclosure ==> set of Identity;
    ProbeAll: set of Identity ==> map Identity to Usage;
    Measure: Enclosure ==> Usage;
    Terminate: Identity ==> ();
    Kill: Enclosure ==> ();
    Close: Enclosure ==> ()
definitions
types
  -- 一个进程的身份：进程号加出生标记；进程号被复用时出生标记不同
  Identity ::
    pid   : nat    -- 操作系统分配的进程号
    birth : token; -- 这个进程出生时刻的标记，由平台给出

  -- 宿主死亡后围栏成员的命运
  Guarantee = <Kernel> | <Cooperative> | <None>;
  -- <Kernel>: 内核终止全部成员，宿主怎样死亡都成立
  -- <Cooperative>: 宿主正常退出前自己终止成员；崩溃后无人清理
  -- <None>: 没有清理

  -- 一个围栏能保证到什么程度；使用方按这五项分支，不按平台分支
  Capability ::
    exclusive   : bool       -- 成员只可能是宿主自己起的进程及其后代
    inescapable : bool       -- 成员的后代自动加入，成员不能自行离开
    guarantee   : Guarantee  -- 宿主死亡后成员的命运
    aggregate   : bool       -- Measure 的读数含已退出成员
    enforce     : bool;      -- 能对围栏设置强制上限

  -- 一个围栏的身份；平台造出，使用方不读结构
  Enclosure = token;

  -- 开出的围栏与它的能力
  Opened ::
    enclosure  : Enclosure    -- 开出的围栏
    capability : Capability;  -- 这个围栏能保证到什么程度

  -- Open 的结局：开出围栏，或在当前环境里开不出来；开不出来时使用方按无围栏继续
  OpenOutcome = Opened | <Unavailable>;

  -- 要起的程序；平台不读结构
  Program = token;

  -- Spawn 的结局：起来了就交回身份
  SpawnOutcome = Identity | <Failed>;

  -- 一次读数：CPU 与 IO 为累计值，内存为当前占用
  Usage ::
    cpuNanos    : nat   -- 累计 CPU 时间，纳秒
    readBytes   : nat   -- 累计读入字节
    writeBytes  : nat   -- 累计写出字节
    memoryBytes : nat;  -- 当前内存占用，按平台的实际占用口径

  -- 操作系统的事实
state Os of
  open    : map Enclosure to Capability      -- 开着的围栏与各自的能力
  members : map Enclosure to set of Identity -- 每个围栏此刻的成员
  alive   : map Identity to Usage            -- 活着的进程与各自此刻的用量
  charged : map Enclosure to Usage           -- 已退出成员留在围栏里的累计用量
  inv mk_Os(o, m, a, c) ==
    dom m = dom o and dom c = dom o
    and (forall e in set dom m & m(e) subset dom a)
  init s == s = mk_Os({|->}, {|->}, {|->}, {|->})
end

functions
  -- 没有用量
  Zero: () -> Usage
  Zero() == mk_Usage(0, 0, 0, 0);

  -- 两份读数相加
  Add: Usage * Usage -> Usage
  Add(a, b) ==
    mk_Usage(a.cpuNanos + b.cpuNanos, a.readBytes + b.readBytes, a.writeBytes + b.writeBytes, a.memoryBytes + b.memoryBytes);

  -- 一组进程的读数之和；两个实现必须得出同一结果，所以写显式体
  Total: set of Identity * map Identity to Usage -> Usage
  Total(ids, usage) ==
    if ids = {} then Zero()
    else let i in set ids in Add(usage(i), Total(ids \ {i}, usage))
  pre ids subset dom usage
  measure Size;

  -- Total 的递归度量：每次递归少一个进程
  Size: set of Identity * map Identity to Usage -> nat
  Size(ids, -) == card ids;

operations
  -- 在一个已开的围栏之内（或顶层）开一个新围栏；开不出来时什么都不变
  Open(within: [Enclosure]) r: OpenOutcome
  ext wr open wr members wr charged
  pre within <> nil => within in set dom open
  post (r = <Unavailable> and open = open~ and members = members~ and charged = charged~)
    or (is_Opened(r)
        and r.enclosure not in set dom open~
        and open = open~ ++ {r.enclosure |-> r.capability}
        and members = members~ ++ {r.enclosure |-> {}}
        and charged = charged~ ++ {r.enclosure |-> Zero()});

  -- 起一个程序；给了围栏就在围栏里起，起来的进程成为成员
  Spawn(program: Program, within: [Enclosure]) r: SpawnOutcome
  ext wr alive wr members
  pre within <> nil => within in set dom members
  post (r = <Failed> and alive = alive~ and members = members~)
    or (is_Identity(r)
        and r not in set dom alive~
        and r in set dom alive
        and alive~ = {r} <-: alive
        and (within = nil => members = members~)
        and (within <> nil => members = members~ ++ {within |-> members~(within) union {r}}));

  -- 围栏此刻的成员
  Members(enclosure: Enclosure) r: set of Identity
  ext rd members
  pre enclosure in set dom members
  post r = members(enclosure);

  -- 读一组进程此刻的用量；已不存在的进程不出现在结果里
  ProbeAll(ids: set of Identity) r: map Identity to Usage
  ext rd alive
  post r = ids <: alive;

  -- 读一个围栏的用量：能力为 aggregate 时含已退出成员，否则只含活着的成员
  Measure(enclosure: Enclosure) r: Usage
  ext rd open rd members rd alive rd charged
  pre enclosure in set dom open
  post r = (if open(enclosure).aggregate
            then Add(charged(enclosure), Total(members(enclosure), alive))
            else Total(members(enclosure), alive));

  -- 终止一个进程；按身份操作，进程号已被复用时不影响新进程；退出成员的用量计入它所在围栏的累计
  Terminate(id: Identity)
  ext wr alive wr members wr charged rd open
  post alive = {id} <-: alive~
    and (forall e in set dom members &
          members(e) = members~(e) \ {id}
          and charged(e) = (if id in set members~(e) then Add(charged~(e), alive~(id)) else charged~(e)));

  -- 终止一个围栏的全部成员
  Kill(enclosure: Enclosure)
  ext wr alive wr members wr charged rd open
  pre enclosure in set dom open
  post alive = members~(enclosure) <-: alive~
    and (forall e in set dom members &
          members(e) = members~(e) \ members~(enclosure)
          and charged(e) = Add(charged~(e), Total(members~(e) inter members~(enclosure), alive~)));

  -- 关闭一个已经没有成员的围栏
  Close(enclosure: Enclosure)
  ext wr open wr members wr charged
  pre enclosure in set dom open and members(enclosure) = {}
  post open = {enclosure} <-: open~
    and members = {enclosure} <-: members~
    and charged = {enclosure} <-: charged~;
end Platform
```
