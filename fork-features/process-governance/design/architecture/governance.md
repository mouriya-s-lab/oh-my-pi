# 共用的类型

```vdm
module Governance
exports
  types
    struct Identity; UnitId; Enclosure; struct Guarantee; struct Capability;
    struct Cumulative; struct Usage; struct Coverage; struct Reading
  functions
    NoCumulative: () -> Cumulative;
    AddCumulative: Cumulative * Cumulative -> Cumulative;
    Sum: set of Identity * map Identity to Usage -> Reading;
    Merge: Reading * Reading -> Reading
definitions
types
  -- 一个进程的身份：进程号加出生标记；进程号被复用时出生标记不同
  Identity ::
    pid   : nat    -- 操作系统分配的进程号
    birth : token; -- 这个进程出生时刻的标记，由平台给出

  -- 一个归属单位的身份；台账造出，起进程时作为血统标记盖进环境，后代继承
  UnitId = token;

  -- 一个围栏的身份；平台造出，使用方不读结构
  Enclosure = token;

  -- 宿主死亡后围栏成员的命运
  Guarantee = <Kernel> | <Cooperative>;
  -- <Kernel>: 内核终止全部成员，宿主怎样死亡都成立
  -- <Cooperative>: 宿主正常退出前自己终止成员；崩溃后无人清理

  -- 这个平台的围栏能保证到什么程度；使用方按这两项分支，不按平台分支
  Capability ::
    guarantee : Guarantee  -- 宿主死亡后成员的命运
    contained : bool;      -- 成员不能自行离开围栏；为假时成员可能离开，要按单位身份补找

  -- 累计量：进程出生以来的总和，只增不减
  Cumulative ::
    cpuNanos   : nat   -- 累计 CPU 时间，纳秒
    readBytes  : nat   -- 累计读入字节
    writeBytes : nat;  -- 累计写出字节

  -- 一个活着的进程此刻的用量
  Usage ::
    cumulative  : Cumulative  -- 出生以来的累计
    memoryBytes : nat;        -- 此刻的内存占用，按平台的实际占用口径

  -- 累计量覆盖的范围
  Coverage = <Complete> | <LiveOnly>;
  -- <Complete>: 含已退出的进程
  -- <LiveOnly>: 只含取回那一刻活着的进程

  -- 一份读数：累计量带覆盖范围，内存只对活着的进程有意义
  Reading ::
    cumulative  : Cumulative  -- 累计量之和
    coverage    : Coverage    -- 累计量覆盖的范围
    memoryBytes : nat         -- 取回那一刻活着的进程的内存之和
    memoryPeak  : [nat];      -- 围栏整体的历史峰值内存；平台给不出或合并多份读数后为空

functions
  -- 没有累计量
  NoCumulative: () -> Cumulative
  NoCumulative() == mk_Cumulative(0, 0, 0);

  -- 两份累计量相加
  AddCumulative: Cumulative * Cumulative -> Cumulative
  AddCumulative(a, b) ==
    mk_Cumulative(a.cpuNanos + b.cpuNanos, a.readBytes + b.readBytes, a.writeBytes + b.writeBytes);

  -- 一组活着的进程的读数之和：只含活着的，没有整体峰值；两个实现必须得出同一结果，所以写显式体
  Sum: set of Identity * map Identity to Usage -> Reading
  Sum(ids, usage) ==
    if ids = {} then mk_Reading(NoCumulative(), <LiveOnly>, 0, nil)
    else let i in set ids in
      let rest = Sum(ids \ {i}, usage) in
        mk_Reading(AddCumulative(usage(i).cumulative, rest.cumulative), <LiveOnly>,
                   usage(i).memoryBytes + rest.memoryBytes, nil)
  pre ids subset dom usage
  measure Size;

  -- Sum 的递归度量：每次递归少一个进程
  Size: set of Identity * map Identity to Usage -> nat
  Size(ids, -) == card ids;

  -- 两份读数合成一份：累计量相加，只要有一份不完整合成的就不完整；内存相加；峰值不可相加，合成后为空
  Merge: Reading * Reading -> Reading
  Merge(a, b) ==
    mk_Reading(AddCumulative(a.cumulative, b.cumulative),
               if a.coverage = <Complete> and b.coverage = <Complete> then <Complete> else <LiveOnly>,
               a.memoryBytes + b.memoryBytes,
               nil);
end Governance
```
