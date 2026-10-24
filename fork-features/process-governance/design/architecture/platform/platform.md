# 平台连接

```vdm
module Platform
imports from Governance
  types
    Identity renamed Identity
exports
  types
    Program; struct SpawnOutcome; struct Guarantee;
    struct Cumulative; struct Coverage; struct Reading
  functions
    AddCumulative: Cumulative * Cumulative -> Cumulative
  operations
    Describe: () ==> Guarantee;
    Spawn: Program ==> SpawnOutcome;
    Measure: Identity ==> Reading;
    Kill: Identity ==> ()
definitions
types
  -- 要起的程序；平台不读结构
  Program = token;

  -- Spawn 的结局：起来了就交回这棵受管进程树的根身份，否则为失败
  SpawnOutcome = Identity | <Failed>;

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

  -- 一个活着的成员进程此刻的用量
  Usage ::
    cumulative  : Cumulative  -- 出生以来的累计
    memoryBytes : nat;        -- 此刻的内存占用，按平台的实际占用口径

  -- 操作系统的事实
state Os of
  guarantee : Guarantee                        -- 宿主死亡后成员的命运
  members   : map Identity to set of Identity  -- 尚未释放的受管进程树与各自此刻活着的成员；成员退完时为空集
  alive     : map Identity to Usage            -- 活着的进程与各自此刻的用量
  charged   : map Identity to Cumulative       -- 已退出成员留在树里的累计量（平台有树级账本的那些）
  peak      : map Identity to nat              -- 整棵树的历史峰值内存（平台给得出的那些）
  inv mk_Os(-, m, a, c, p) ==
    (forall t in set dom m & m(t) subset dom a)
    and (forall t1, t2 in set dom m & t1 <> t2 => m(t1) inter m(t2) = {})
    and dom c subset dom m and dom p subset dom m
  init s == s = mk_Os(<Cooperative>, {|->}, {|->}, {|->}, {|->})
end

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

  -- 一组活着的成员进程的读数之和
  Sum: set of Identity * map Identity to Usage -> Reading
  Sum(ids, usage) ==
    if ids = {} then ZeroReading()
    else let i in set ids in
      let rest = Sum(ids \ {i}, usage) in
        mk_Reading(AddCumulative(usage(i).cumulative, rest.cumulative), <LiveOnly>,
                   usage(i).memoryBytes + rest.memoryBytes, nil)
  pre ids subset dom usage
  measure Size;

  -- Sum 的递归度量：每次递归少一个成员进程
  Size: set of Identity * map Identity to Usage -> nat
  Size(ids, -) == card ids;

  -- 一棵受管进程树的读数：有已退出成员账本时累计量为完整，否则只含此刻活着的成员
  Collect: set of Identity * map Identity to Usage * [Cumulative] * [nat] -> Reading
  Collect(ids, usage, exited, peak) ==
    let live = Sum(ids, usage) in
      if exited = nil
      then mk_Reading(live.cumulative, <LiveOnly>, live.memoryBytes, peak)
      else mk_Reading(AddCumulative(live.cumulative, exited), <Complete>, live.memoryBytes, peak)
  pre ids subset dom usage;

operations
  -- 宿主死亡后受管进程树成员的命运；整个宿主生命周期内不变
  Describe() r: Guarantee
  ext rd guarantee
  post r = guarantee;

  -- 起一个程序并建立以它为根的受管进程树；失败时什么都不变
  Spawn(program: Program) r: SpawnOutcome
  ext wr alive wr members wr charged wr peak
  post (r = <Failed> and alive = alive~ and members = members~ and charged = charged~ and peak = peak~)
    or (is_Identity(r)
        and r not in set dom alive~
        and r not in set dom members~
        and r in set dom alive
        and alive~ = {r} <-: alive
        and members = members~ ++ {r |-> {r}}
        and {r} <-: charged = charged~
        and (r in set dom charged => charged(r) = NoCumulative())
        and {r} <-: peak = peak~);

  -- 读一棵受管进程树的读数：有已退出成员账本时标完整，否则只含此刻活着的成员；树已释放时为空读数
  Measure(tree: Identity) r: Reading
  ext rd members rd alive rd charged rd peak
  post (tree not in set dom members => r = ZeroReading())
    and (tree in set dom members =>
          r = Collect(members(tree), alive,
                      if tree in set dom charged then charged(tree) else nil,
                      if tree in set dom peak then peak(tree) else nil));

  -- 终止一棵受管进程树里残余的全部成员并释放这棵树；释放两次与一次效果相同
  Kill(tree: Identity)
  ext wr alive wr members wr charged wr peak
  post (tree not in set dom members~ =>
          alive = alive~ and members = members~ and charged = charged~ and peak = peak~)
    and (tree in set dom members~ =>
          alive = members~(tree) <-: alive~
          and members = {tree} <-: members~
          and charged = {tree} <-: charged~
          and peak = {tree} <-: peak~);
end Platform
```
