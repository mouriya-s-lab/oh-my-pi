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
      Begin: [UnitId] ==> UnitId renamed Begin;
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
  operations
    Launch: UnitId * Program ==> LaunchOutcome;
    JudgeAlert: UnitId * Reading * Limit ==> AlertOutcome;
    SampleTree: UnitId * Identity * Limit ==> [SampleOutcome];
    SamplePair: UnitId * Identity * Identity * Limit ==> [SampleOutcome];
    RetireTree: UnitId * Identity ==> ();
    FinishUnit: UnitId ==> bool;
    ExitTree: Identity ==> ();
    RunNested: Program * Program * Limit ==> [SampleOutcome]
definitions
types
  -- 告警阈值：CPU 时间、读写总字节或当前内存任一越过上限即超限
  Limit ::
    cpuNanos    : nat   -- CPU 时间上限，纳秒
    ioBytes     : nat   -- 读入加写出字节上限
    memoryBytes : nat;  -- 当前内存占用上限，字节

  -- Launch 的结局：登记在册的受管进程树身份、平台起进程失败，或归属单位不在册
  LaunchOutcome = Identity | <Failed> | <NotLive>;

  -- 一次超限告警判定的结局：首次超限触发告警、同一单位已告警过予以抑制，或未超限
  AlertOutcome = <Triggered> | <Suppressed> | <Normal>;

  -- 一次采样的结果：用量读数与告警判定结局
  SampleOutcome ::
    reading : Reading       -- 采到的用量读数
    alert   : AlertOutcome; -- 本次采样的告警判定结局

functions
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

operations
  -- 场景：先核对单位在册，再起受管进程树并登记到该单位名下；失败或不在册时不留登记
  Launch: UnitId * Program ==> LaunchOutcome
  Launch(unit, program) ==
    if not Live(unit) then return <NotLive>
    else
      let outcome = Spawn(program) in
        if outcome = <Failed> then return <Failed>
        else (Attach(unit, outcome); return outcome);

  -- 场景：按阈值判定一份读数是否触发告警；同一归属单位在存续期内至多触发一次
  JudgeAlert: UnitId * Reading * Limit ==> AlertOutcome
  JudgeAlert(unit, reading, limit) ==
    if not Live(unit) or not Exceeded(reading, limit) then return <Normal>
    elseif Alerted(unit) then return <Suppressed>
    else (MarkAlerted(unit); return <Triggered>);

  -- 场景：采集单位名下一棵受管进程树的读数并判定告警；直接返回单树读数以保留 Complete 与峰值
  SampleTree: UnitId * Identity * Limit ==> [SampleOutcome]
  SampleTree(unit, tree, limit) ==
    if tree not in set Trees(unit) then return nil
    else
      let reading = Measure(tree) in
        let alert = JudgeAlert(unit, reading, limit) in
          return mk_SampleOutcome(reading, alert);

  -- 场景：合并采集单位名下两棵不同受管进程树的读数并判定告警
  SamplePair: UnitId * Identity * Identity * Limit ==> [SampleOutcome]
  SamplePair(unit, first, second, limit) ==
    if first not in set Trees(unit) or second not in set Trees(unit) or first = second then return nil
    else
      let reading = Merge(Measure(first), Measure(second)) in
        let alert = JudgeAlert(unit, reading, limit) in
          return mk_SampleOutcome(reading, alert);

  -- 场景：终止并释放单位名下的一棵受管进程树
  RetireTree: UnitId * Identity ==> ()
  RetireTree(unit, tree) ==
    if tree in set Trees(unit) then
      (Kill(tree); Release(tree));

  -- 场景：在内层子单位与名下受管进程树已全部清空时结束该单位
  FinishUnit: UnitId ==> bool
  FinishUnit(unit) ==
    if Live(unit) and Children(unit) = {} and Trees(unit) = {}
    then (End(unit); return true)
    else return false;

  -- 场景：宿主进程退出前按平台保证处置一棵受管进程树
  ExitTree: Identity ==> ()
  ExitTree(tree) ==
    cases Describe():
      <Kernel> -> skip,
      <Cooperative> -> (Kill(tree); Release(tree))
    end;

  -- 场景：走完外层单位与内层子单位从嵌套开启、起进程、采样告警、由内向外收尾到结束的完整生命周期
  RunNested: Program * Program * Limit ==> [SampleOutcome]
  RunNested(outerProgram, innerProgram, limit) ==
    let outer = Begin(nil) in
      let inner = Begin(outer) in
        let innerLaunch = Launch(inner, innerProgram) in
          let outerLaunch = Launch(outer, outerProgram) in
            (if is_Identity(innerLaunch) then
               let - = SampleTree(inner, innerLaunch, limit) in
                 RetireTree(inner, innerLaunch);
             let - = FinishUnit(inner) in
               if not is_Identity(outerLaunch) then
                 let - = FinishUnit(outer) in return nil
               else
                 let sampled = SampleTree(outer, outerLaunch, limit) in
                   (RetireTree(outer, outerLaunch);
                    let - = FinishUnit(outer) in return sampled));
end Host
```
