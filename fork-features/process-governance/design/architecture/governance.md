# 共用的类型与判定

```vdm
module Governance
exports
  types
    struct Identity; UnitId; struct Guarantee;
    struct Cumulative; struct Coverage; struct Reading; struct Limit
  functions
    NoCumulative: () -> Cumulative;
    AddCumulative: Cumulative * Cumulative -> Cumulative;
    ZeroReading: () -> Reading;
    Merge: Reading * Reading -> Reading;
    Exceeded: Reading * Limit -> bool
definitions
types
  -- 一个进程的身份：进程号加出生标记；对 Spawn 起的根进程，它同时是那棵受管进程树的身份
  Identity ::
    pid   : nat    -- 操作系统分配的进程号
    birth : token; -- 这个进程出生时刻的标记，由平台给出

  -- 一个归属单位的身份；台账造出，使用方不读结构
  UnitId = token;

  -- 宿主死亡后受管进程树成员的命运
  Guarantee = <Kernel> | <Cooperative>;
  -- <Kernel>: 内核终止全部成员，宿主怎样死亡都成立
  -- <Cooperative>: 宿主正常退出前自己终止成员；崩溃后无人清理

  -- 累计量：进程出生以来的总和，只增不减
  Cumulative ::
    cpuNanos   : nat   -- 累计 CPU 时间，纳秒
    readBytes  : nat   -- 累计读入字节
    writeBytes : nat;  -- 累计写出字节

  -- 累计量覆盖的范围
  Coverage = <Complete> | <LiveOnly>;
  -- <Complete>: 含已退出的成员进程
  -- <LiveOnly>: 只含取回那一刻活着的成员进程

  -- 一棵或多棵受管进程树的读数：累计量带覆盖范围，内存只算此刻活着的成员
  Reading ::
    cumulative  : Cumulative  -- 累计量之和
    coverage    : Coverage    -- 累计量覆盖的范围
    memoryBytes : nat         -- 取回那一刻活着的成员内存之和
    memoryPeak  : [nat];      -- 整棵树的历史峰值内存；平台给不出或合并多棵树后为空

  -- 告警阈值：CPU 时间、读写总字节或当前内存任一越过上限即超限
  Limit ::
    cpuNanos    : nat   -- CPU 时间上限，纳秒
    ioBytes     : nat   -- 读入加写出字节上限
    memoryBytes : nat;  -- 当前内存占用上限，字节

functions
  -- 没有累计量
  NoCumulative: () -> Cumulative
  NoCumulative() == mk_Cumulative(0, 0, 0);

  -- 两份累计量相加
  AddCumulative: Cumulative * Cumulative -> Cumulative
  AddCumulative(a, b) ==
    mk_Cumulative(a.cpuNanos + b.cpuNanos, a.readBytes + b.readBytes, a.writeBytes + b.writeBytes);

  -- 空读数：没有成员、没有累计量
  ZeroReading: () -> Reading
  ZeroReading() == mk_Reading(NoCumulative(), <LiveOnly>, 0, nil);

  -- 两棵受管进程树的读数合成一份：累计量相加，只要有一份不完整合成的就不完整；内存相加；峰值不可相加，合成后为空
  Merge: Reading * Reading -> Reading
  Merge(a, b) ==
    mk_Reading(AddCumulative(a.cumulative, b.cumulative),
               if a.coverage = <Complete> and b.coverage = <Complete> then <Complete> else <LiveOnly>,
               a.memoryBytes + b.memoryBytes,
               nil);

  -- 一份读数是否越过阈值：CPU、读写总字节或当前内存任一超过上限即为真；两个实现必须得出同一结果，所以写显式体
  Exceeded: Reading * Limit -> bool
  Exceeded(reading, limit) ==
    reading.cumulative.cpuNanos > limit.cpuNanos
    or reading.cumulative.readBytes + reading.cumulative.writeBytes > limit.ioBytes
    or reading.memoryBytes > limit.memoryBytes;
end Governance
```
