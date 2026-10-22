# 平台连接

```vdm
module Platform
imports from Governance
  types
    Identity renamed Identity;
    UnitId renamed UnitId;
    Enclosure renamed Enclosure;
    Capability renamed Capability;
    Cumulative renamed Cumulative;
    Usage renamed Usage;
    Reading renamed Reading
  functions
    NoCumulative: () -> Cumulative renamed NoCumulative;
    AddCumulative: Cumulative * Cumulative -> Cumulative renamed AddCumulative;
    Sum: set of Identity * map Identity to Usage -> Reading renamed Sum
exports
  types Program; struct Placement; struct Started; struct SpawnOutcome
  operations
    Describe: () ==> Capability;
    Spawn: Program * Placement * UnitId ==> SpawnOutcome;
    Members: Enclosure ==> set of Identity;
    Marked: UnitId ==> set of Identity;
    ProbeAll: set of Identity ==> map Identity to Usage;
    Measure: Enclosure ==> Reading;
    Terminate: Identity ==> ();
    Kill: Enclosure ==> ()
definitions
types
  -- 要起的程序；平台不读结构
  Program = token;

  -- 起进程的一方要不要给这个进程开围栏
  Placement = <Fenced> | <Unfenced>;

  -- 起来的进程与随它诞生的围栏；要了围栏却开不出来时围栏为空
  Started ::
    id        : Identity      -- 起来的进程
    enclosure : [Enclosure];  -- 随它诞生的围栏

  -- Spawn 的结局：起来了，或没起来
  SpawnOutcome = Started | <Failed>;

  -- 操作系统的事实
state Os of
  ability : Capability                       -- 这个平台的围栏能保证到什么程度
  members : map Enclosure to set of Identity -- 尚未释放的围栏与各自此刻活着的成员；成员退完时为空集
  marked  : map Identity to UnitId           -- 活着的进程在环境里带的单位身份（读得到环境的那些）
  alive   : map Identity to Usage            -- 活着的进程与各自此刻的用量
  charged : map Enclosure to Cumulative      -- 已退出成员留在围栏里的累计量（平台有围栏账本的那些）
  peak    : map Enclosure to nat             -- 围栏整体的历史峰值内存（平台给得出的那些）
  inv mk_Os(-, m, mk, a, c, p) ==
    (forall e in set dom m & m(e) subset dom a)
    and (forall e1, e2 in set dom m & e1 <> e2 => m(e1) inter m(e2) = {})
    and dom mk subset dom a
    and dom c subset dom m and dom p subset dom m
  init s == s = mk_Os(mk_Capability(<Cooperative>, false), {|->}, {|->}, {|->}, {|->}, {|->})
end

functions
  -- 一个进程所在的围栏；不在任何围栏里为空
  Within: Identity * map Enclosure to set of Identity -> [Enclosure]
  Within(id, m) ==
    if exists e in set dom m & id in set m(e)
    then iota e in set dom m & id in set m(e)
    else nil;

  -- 围栏的读数：有已退出成员账本时累计量为完整，否则只含此刻活着的成员
  Collect: set of Identity * map Identity to Usage * [Cumulative] * [nat] -> Reading
  Collect(ids, usage, exited, peak) ==
    let live = Sum(ids, usage) in
      if exited = nil
      then mk_Reading(live.cumulative, <LiveOnly>, live.memoryBytes, peak)
      else mk_Reading(AddCumulative(live.cumulative, exited), <Complete>, live.memoryBytes, peak)
  pre ids subset dom usage;

operations
  -- 这个平台的围栏能保证到什么程度；整个宿主生命周期内不变
  Describe() r: Capability
  ext rd ability
  post r = ability;

  -- 起一个程序并在环境里盖上单位身份；要围栏时围栏随它诞生，开不出来时它不在任何围栏里
  Spawn(program: Program, placement: Placement, unit: UnitId) r: SpawnOutcome
  ext wr alive wr members wr marked wr charged wr peak
  post (r = <Failed> and alive = alive~ and members = members~ and marked = marked~ and charged = charged~ and peak = peak~)
    or (is_Started(r)
        and r.id not in set dom alive~
        and r.id in set dom alive
        and alive~ = {r.id} <-: alive
        and {r.id} <-: marked = marked~
        and (r.id in set dom marked => marked(r.id) = unit)
        and (placement = <Unfenced> => r.enclosure = nil)
        and (r.enclosure = nil => members = members~ and charged = charged~ and peak = peak~)
        and (r.enclosure <> nil =>
              r.enclosure not in set dom members~
              and members = members~ ++ {r.enclosure |-> {r.id}}
              and {r.enclosure} <-: charged = charged~
              and (r.enclosure in set dom charged => charged(r.enclosure) = NoCumulative())
              and {r.enclosure} <-: peak = peak~));

  -- 围栏此刻活着的成员；成员已退完或围栏已释放时为空集
  Members(enclosure: Enclosure) r: set of Identity
  ext rd members
  post r = (if enclosure in set dom members then members(enclosure) else {});

  -- 环境里带着这个单位身份的活着的进程；读不到环境的进程不出现，所以是下界
  Marked(unit: UnitId) r: set of Identity
  ext rd marked
  post r = {id | id in set dom marked & marked(id) = unit};

  -- 读一组进程此刻的用量；已不存在的进程不出现在结果里
  ProbeAll(ids: set of Identity) r: map Identity to Usage
  ext rd alive
  post r = ids <: alive;

  -- 读一个围栏的读数：围栏有已退出成员账本时标完整，否则只含此刻活着的成员；围栏已释放时为零读数
  Measure(enclosure: Enclosure) r: Reading
  ext rd members rd alive rd charged rd peak
  post r = Collect(if enclosure in set dom members then members(enclosure) else {},
                   alive,
                   if enclosure in set dom charged then charged(enclosure) else nil,
                   if enclosure in set dom peak then peak(enclosure) else nil);

  -- 终止一个进程；按身份操作，进程号已被复用时不影响新进程；若所在围栏有账本则累计量计入，围栏本身保留到 Kill 释放
  Terminate(id: Identity)
  ext wr alive wr members wr marked wr charged
  post alive = {id} <-: alive~
    and marked = {id} <-: marked~
    and (let e = Within(id, members~) in
          (e = nil => members = members~ and charged = charged~)
          and (e <> nil =>
                members = members~ ++ {e |-> members~(e) \ {id}}
                and charged = (if e in set dom charged~
                               then charged~ ++ {e |-> AddCumulative(charged~(e), alive~(id).cumulative)}
                               else charged~)));

  -- 终止一个围栏里残余的全部成员并释放围栏；释放两次与一次效果相同
  Kill(enclosure: Enclosure)
  ext wr alive wr members wr marked wr charged wr peak
  post (enclosure not in set dom members~ =>
          alive = alive~ and members = members~ and marked = marked~ and charged = charged~ and peak = peak~)
    and (enclosure in set dom members~ =>
          alive = members~(enclosure) <-: alive~
          and marked = members~(enclosure) <-: marked~
          and members = {enclosure} <-: members~
          and charged = {enclosure} <-: charged~
          and peak = {enclosure} <-: peak~);
end Platform
```
