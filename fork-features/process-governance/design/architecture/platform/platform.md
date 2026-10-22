# 平台连接

```vdm
module Platform
imports from Governance
  types
    Identity renamed Identity;
    Mark renamed Mark;
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
    Spawn: Program * Placement * Mark ==> SpawnOutcome;
    Members: Enclosure ==> set of Identity;
    Marked: Mark ==> set of Identity;
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
  members : map Enclosure to set of Identity -- 每个围栏此刻的成员；没有成员的围栏不存在
  marked  : map Identity to Mark             -- 活着的进程带的标记（读得到环境的那些）
  alive   : map Identity to Usage            -- 活着的进程与各自此刻的用量
  charged : map Enclosure to Cumulative      -- 已退出成员留在围栏里的累计量
  peak    : map Enclosure to nat             -- 围栏整体的历史峰值内存（平台给得出的那些）
  inv mk_Os(-, m, mk, a, c, p) ==
    (forall e in set dom m & m(e) <> {} and m(e) subset dom a)
    and (forall e1, e2 in set dom m & e1 <> e2 => m(e1) inter m(e2) = {})
    and dom mk subset dom a
    and dom c = dom m and dom p subset dom m
  init s == s = mk_Os(mk_Capability(<Cooperative>, false), {|->}, {|->}, {|->}, {|->}, {|->})
end

functions
  -- 一个进程所在的围栏；不在任何围栏里为空
  Within: Identity * map Enclosure to set of Identity -> [Enclosure]
  Within(id, m) ==
    if exists e in set dom m & id in set m(e)
    then iota e in set dom m & id in set m(e)
    else nil;

  -- 读数：围栏整体的累计量含已退出成员时为完整，否则只含活着的
  Collect: set of Identity * map Identity to Usage * Cumulative * [nat] * bool -> Reading
  Collect(ids, usage, charged, peak, complete) ==
    let live = Sum(ids, usage) in
      mk_Reading(AddCumulative(live.cumulative, charged),
                 if complete then <Complete> else <LiveOnly>,
                 live.memoryBytes,
                 peak)
  pre ids subset dom usage;

operations
  -- 这个平台的围栏能保证到什么程度；整个宿主生命周期内不变
  Describe() r: Capability
  ext rd ability
  post r = ability;

  -- 起一个程序并盖上标记；要围栏时围栏随它诞生，开不出来时它不在任何围栏里
  Spawn(program: Program, placement: Placement, mark: Mark) r: SpawnOutcome
  ext wr alive wr members wr marked wr charged
  post (r = <Failed> and alive = alive~ and members = members~ and marked = marked~ and charged = charged~)
    or (is_Started(r)
        and r.id not in set dom alive~
        and r.id in set dom alive
        and alive~ = {r.id} <-: alive
        and marked = marked~ ++ {r.id |-> mark}
        and (placement = <Unfenced> => r.enclosure = nil)
        and (r.enclosure = nil => members = members~ and charged = charged~)
        and (r.enclosure <> nil =>
              r.enclosure not in set dom members~
              and members = members~ ++ {r.enclosure |-> {r.id}}
              and charged = charged~ ++ {r.enclosure |-> NoCumulative()}));

  -- 围栏此刻的成员；围栏已消失时为空集
  Members(enclosure: Enclosure) r: set of Identity
  ext rd members
  post r = (if enclosure in set dom members then members(enclosure) else {});

  -- 带着这个标记的活着的进程；读不到环境的进程不出现，所以是下界
  Marked(mark: Mark) r: set of Identity
  ext rd marked
  post r = {id | id in set dom marked & marked(id) = mark};

  -- 读一组进程此刻的用量；已不存在的进程不出现在结果里
  ProbeAll(ids: set of Identity) r: map Identity to Usage
  ext rd alive
  post r = ids <: alive;

  -- 读一个围栏的读数：累计量含已退出成员，所以完整；峰值在平台给得出时交出
  Measure(enclosure: Enclosure) r: Reading
  ext rd members rd alive rd charged rd peak
  pre enclosure in set dom members
  post r = Collect(members(enclosure), alive, charged(enclosure),
                   if enclosure in set dom peak then peak(enclosure) else nil,
                   true);

  -- 终止一个进程；按身份操作，进程号已被复用时不影响新进程；它的累计量计入所在围栏，围栏空了就消失
  Terminate(id: Identity)
  ext wr alive wr members wr marked wr charged wr peak
  post alive = {id} <-: alive~
    and marked = {id} <-: marked~
    and (let e = Within(id, members~) in
          (e = nil => members = members~ and charged = charged~ and peak = peak~)
          and (e <> nil =>
                (members~(e) = {id} =>
                  members = {e} <-: members~ and charged = {e} <-: charged~ and peak = {e} <-: peak~)
                and (members~(e) <> {id} =>
                      members = members~ ++ {e |-> members~(e) \ {id}}
                      and charged = charged~ ++ {e |-> AddCumulative(charged~(e), alive~(id).cumulative)}
                      and peak = peak~)));

  -- 终止一个围栏的全部成员；围栏随之消失
  Kill(enclosure: Enclosure)
  ext wr alive wr members wr marked wr charged wr peak
  pre enclosure in set dom members
  post alive = members~(enclosure) <-: alive~
    and marked = members~(enclosure) <-: marked~
    and members = {enclosure} <-: members~
    and charged = {enclosure} <-: charged~
    and peak = {enclosure} <-: peak~;
end Platform
```
