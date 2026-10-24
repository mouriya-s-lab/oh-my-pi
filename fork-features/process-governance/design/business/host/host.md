# 宿主生命周期接入

```vdm
module Host
imports
  from Governance
    types
      Identity renamed Identity,
  from Platform
    types
      Program renamed Program;
      SpawnOutcome renamed SpawnOutcome;
      Guarantee renamed Guarantee;
      Cumulative renamed Cumulative;
      Reading renamed Reading
    functions
      AddCumulative: Cumulative * Cumulative -> Cumulative renamed AddCumulative
    operations
      Describe: () ==> Guarantee renamed Describe;
      Spawn: Program ==> SpawnOutcome renamed Spawn;
      Measure: Identity ==> Reading renamed Measure;
      Kill: Identity ==> () renamed Kill,
  from Registry
    types
      UnitId renamed UnitId
    operations
      Live: UnitId ==> bool renamed Live;
      Children: UnitId ==> set of UnitId renamed Children;
      Attach: UnitId * Identity ==> () renamed Attach;
      Trees: UnitId ==> set of Identity renamed Trees;
      Release: Identity ==> () renamed Release;
      Alerted: UnitId ==> bool renamed Alerted;
      MarkAlerted: UnitId ==> () renamed MarkAlerted;
      End: UnitId ==> () renamed End
exports
  types struct Limit; struct LaunchOutcome; struct AlertOutcome; struct SampleOutcome
  functions
    Merge: Reading * Reading -> Reading;
    Exceeded: Reading * Limit -> bool
  operations
    Launch: UnitId * Program ==> LaunchOutcome;
    SampleTree: UnitId * Identity * Limit ==> [SampleOutcome];
    SamplePair: UnitId * Identity * Identity * Limit ==> [SampleOutcome];
    RetireTree: UnitId * Identity * Limit ==> [SampleOutcome];
    FinishUnit: UnitId ==> bool;
    CloseNested: UnitId * UnitId ==> bool;
    ExitTree: Identity ==> ()
definitions
types
  -- 告警阈值：CPU 时间、读写总字节或当前内存任一越过上限即超限
  Limit ::
    cpuNanos    : nat   -- CPU 时间上限，纳秒
    ioBytes     : nat   -- 读入加写出字节上限
    memoryBytes : nat;  -- 当前内存占用上限，字节

  -- Launch 的结局：登记在单位名下的新树、平台起进程失败，或单位不在册；后两支都没有留下登记
  LaunchOutcome = Identity | <Failed> | <NotLive>;

  -- 一次告警判定的结局：首次超限触发、同一单位已告警过而抑制，或正常
  AlertOutcome = <Triggered> | <Suppressed> | <Normal>;

  -- 一次采样交给调用方的结果：采到的读数与它的告警判定结局
  SampleOutcome ::
    reading : Reading       -- 这次采到的读数
    alert   : AlertOutcome; -- 这次采样的告警判定结局

functions
  -- 两棵树的读数合成一份：两份都完整时才完整；峰值不能跨树相加，合成后为空；两个实现必须得出同一结果，所以写显式体
  Merge: Reading * Reading -> Reading
  Merge(a, b) ==
    mk_Reading(AddCumulative(a.cumulative, b.cumulative),
               if a.coverage = <Complete> and b.coverage = <Complete> then <Complete> else <LiveOnly>,
               a.memoryBytes + b.memoryBytes,
               nil);

  -- 读数是否超限：任一项严格超过上限即超限，不看峰值；两个实现必须得出同一结果，所以写显式体
  Exceeded: Reading * Limit -> bool
  Exceeded(reading, limit) ==
    reading.cumulative.cpuNanos > limit.cpuNanos
    or reading.cumulative.readBytes + reading.cumulative.writeBytes > limit.ioBytes
    or reading.memoryBytes > limit.memoryBytes;

operations
  -- 场景：先核对单位在册，再起树，成功才登记到该单位名下
  Launch: UnitId * Program ==> LaunchOutcome
  Launch(unit, program) ==
    if not Live(unit) then return <NotLive>
    else
      let outcome = Spawn(program) in
        if outcome = <Failed> then return <Failed>
        else (Attach(unit, outcome); return outcome);

  -- 场景：按单位去重判定一份读数；同一单位存续期内至多触发一次
  JudgeAlert: UnitId * Reading * Limit ==> AlertOutcome
  JudgeAlert(unit, reading, limit) ==
    if not Live(unit) or not Exceeded(reading, limit) then return <Normal>
    elseif Alerted(unit) then return <Suppressed>
    else (MarkAlerted(unit); return <Triggered>);

  -- 场景：采单位名下一棵树；直接用平台读数，保留完整性与峰值；树不在该单位名下时不采样
  SampleTree: UnitId * Identity * Limit ==> [SampleOutcome]
  SampleTree(unit, tree, limit) ==
    if tree not in set Trees(unit) then return nil
    else
      let reading = Measure(tree) in
        let alert = JudgeAlert(unit, reading, limit) in
          return mk_SampleOutcome(reading, alert);

  -- 场景：合成单位名下两棵不同的树的读数再判定；任一棵不在该单位名下或两棵相同时不采样
  SamplePair: UnitId * Identity * Identity * Limit ==> [SampleOutcome]
  SamplePair(unit, first, second, limit) ==
    if first not in set Trees(unit) or second not in set Trees(unit) or first = second then return nil
    else
      let reading = Merge(Measure(first), Measure(second)) in
        let alert = JudgeAlert(unit, reading, limit) in
          return mk_SampleOutcome(reading, alert);

  -- 场景：收尾单位名下一棵树：先做最后一次采样，再终止并释放平台上的树，最后撤销登记
  RetireTree: UnitId * Identity * Limit ==> [SampleOutcome]
  RetireTree(unit, tree, limit) ==
    if tree not in set Trees(unit) then return nil
    else
      let final = SampleTree(unit, tree, limit) in
        (Kill(tree); Release(tree); return final);

  -- 场景：单位活着、内层已全部结束、名下树已全部撤销时结束它，否则不结束
  FinishUnit: UnitId ==> bool
  FinishUnit(unit) ==
    if Live(unit) and Children(unit) = {} and Trees(unit) = {}
    then (End(unit); return true)
    else return false;

  -- 场景：由内向外收尾一对嵌套单位：内层结束之后才结束外层
  CloseNested: UnitId * UnitId ==> bool
  CloseNested(outer, inner) ==
    if inner not in set Children(outer) then return false
    else
      let innerDone = FinishUnit(inner) in
        if not innerDone then return false
        else
          let outerDone = FinishUnit(outer) in
            return outerDone;

  -- 场景：宿主正常退出前处置一棵未释放的树：协作平台上终止释放并撤销登记，内核保证平台上交给内核
  ExitTree: Identity ==> ()
  ExitTree(tree) ==
    cases Describe():
      <Kernel> -> skip,
      <Cooperative> -> (Kill(tree); Release(tree))
    end;
end Host
```
