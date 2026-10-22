# 宿主生命周期接入

```vdm
module Host
imports
  from Governance
    types
      Identity renamed Identity;
      UnitId renamed UnitId;
      Enclosure renamed Enclosure;
      Capability renamed Capability;
      Usage renamed Usage;
      Reading renamed Reading
    functions
      Sum: set of Identity * map Identity to Usage -> Reading renamed Sum;
      Merge: Reading * Reading -> Reading renamed Merge,
  from Platform
    types
      Program renamed Program;
      Placement renamed Placement;
      SpawnOutcome renamed SpawnOutcome
    operations
      Describe: () ==> Capability renamed Describe;
      Spawn: Program * Placement * UnitId ==> SpawnOutcome renamed Spawn;
      Members: Enclosure ==> set of Identity renamed Members;
      Marked: UnitId ==> set of Identity renamed Marked;
      ProbeAll: set of Identity ==> map Identity to Usage renamed ProbeAll;
      Measure: Enclosure ==> Reading renamed Measure;
      Terminate: Identity ==> () renamed Terminate;
      Kill: Enclosure ==> () renamed Kill,
  from Registry
    operations
      Begin: [UnitId] ==> UnitId renamed Begin;
      Attach: UnitId * Enclosure ==> () renamed Attach;
      Track: UnitId * Identity ==> () renamed Track;
      Enclosures: UnitId ==> set of Enclosure renamed Enclosures;
      Unfenced: UnitId ==> set of Identity renamed Unfenced;
      Release: Enclosure ==> () renamed Release;
      Drop: Identity ==> () renamed Drop;
      End: UnitId ==> () renamed End
exports
  functions
    Escaped: set of Identity * set of Identity -> set of Identity;
    Outside: set of Identity * set of Identity * set of Identity * bool -> set of Identity;
    Exceeded: Reading * nat -> bool
  operations
    Launch: UnitId * Program * Placement ==> SpawnOutcome;
    Sample: UnitId * Enclosure ==> Reading;
    RetireFence: UnitId * Enclosure ==> ();
    RetireProcess: UnitId * Identity ==> ();
    ExitFence: Enclosure ==> ();
    RunUnit: Program * Placement ==> [Reading]
definitions
functions
  -- 带着单位身份但已经不在围栏里的进程：逃出围栏的后代
  Escaped: set of Identity * set of Identity -> set of Identity
  Escaped(marked, enclosed) == marked \ enclosed;

  -- 一个单位在围栏之外需要单独计量与终止的全部进程：contained 为真时只有无围栏进程，为假时并上逃出围栏的后代
  Outside: set of Identity * set of Identity * set of Identity * bool -> set of Identity
  Outside(unfenced, marked, enclosed, contained) ==
    if contained then unfenced else unfenced union Escaped(marked, enclosed);

  -- 一份读数的内存是否越过阈值
  Exceeded: Reading * nat -> bool
  Exceeded(reading, limitBytes) == reading.memoryBytes > limitBytes;

operations
  -- 场景：在单位名下起进程；有围栏记围栏，无围栏记进程，失败时不登记
  Launch: UnitId * Program * Placement ==> SpawnOutcome
  Launch(unit, program, placement) ==
    let outcome = Spawn(program, placement, unit) in
      if outcome = <Failed> then return <Failed>
      else
        (if outcome.enclosure = nil then Track(unit, outcome.id) else Attach(unit, outcome.enclosure);
         return outcome);

  -- 场景：采集一个单位一个围栏与全部围栏外进程的合并读数
  Sample: UnitId * Enclosure ==> Reading
  Sample(unit, enclosure) ==
    let cap = Describe() in
      let measured = Measure(enclosure) in
        let enclosed = Members(enclosure) in
          let marked = if cap.contained then {} else Marked(unit) in
            let unfenced = Unfenced(unit) in
              let probes = ProbeAll(Outside(unfenced, marked, enclosed, cap.contained)) in
                return Merge(measured, Sum(dom probes, probes));

  -- 场景：终止并释放单位名下的一个围栏
  RetireFence: UnitId * Enclosure ==> ()
  RetireFence(unit, enclosure) ==
    if enclosure in set Enclosures(unit) then
      (Kill(enclosure); Release(enclosure));

  -- 场景：围栏已清完后，终止并撤销单位名下一个无围栏进程或逃出围栏的后代
  RetireProcess: UnitId * Identity ==> ()
  RetireProcess(unit, id) ==
    let cap = Describe() in
      let marked = if cap.contained then {} else Marked(unit) in
        if id in set Outside(Unfenced(unit), marked, {}, cap.contained) then
          (Terminate(id); Drop(id));

  -- 场景：宿主退出前按平台保证处置一个围栏
  ExitFence: Enclosure ==> ()
  ExitFence(enclosure) ==
    let cap = Describe() in
      cases cap.guarantee:
        <Kernel> -> skip,
        <Cooperative> -> (Kill(enclosure); Release(enclosure))
      end;

  -- 场景：走完一个单位从开始、起进程、读用量、收尾到结束的完整生命周期
  RunUnit: Program * Placement ==> [Reading]
  RunUnit(program, placement) ==
    let unit = Begin(nil) in
      let outcome = Launch(unit, program, placement) in
        if outcome = <Failed> then (End(unit); return nil)
        elseif outcome.enclosure = nil then
          let probes = ProbeAll(Unfenced(unit)) in
            let reading = Sum(dom probes, probes) in
              (RetireProcess(unit, outcome.id); End(unit); return reading)
        else
          let reading = Sample(unit, outcome.enclosure) in
            (RetireFence(unit, outcome.enclosure); End(unit); return reading);
end Host
```
