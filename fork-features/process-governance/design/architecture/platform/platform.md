# 平台连接

```vdm
module Platform
imports from Governance
  types
    Identity renamed Identity;
    Usage renamed Usage;
    Enclosure renamed Enclosure;
    Capability renamed Capability;
    Opened renamed Opened
  functions
    Zero: () -> Usage renamed Zero;
    Add: Usage * Usage -> Usage renamed Add;
    Total: set of Identity * map Identity to Usage -> Usage renamed Total
exports
  types Program; struct OpenOutcome; struct SpawnOutcome
  operations
    Open: () ==> OpenOutcome;
    Spawn: Program * [Enclosure] ==> SpawnOutcome;
    Members: Enclosure ==> set of Identity;
    Related: set of Identity ==> set of Identity;
    ProbeAll: set of Identity ==> map Identity to Usage;
    Measure: Enclosure ==> Usage;
    Terminate: Identity ==> ();
    Kill: Enclosure ==> ();
    Close: Enclosure ==> ();
    Abandon: Enclosure ==> ()
definitions
types
  -- 要起的程序；平台不读结构
  Program = token;

  -- Open 的结局：开出围栏，或在当前环境里开不出来；开不出来时使用方按无围栏继续
  OpenOutcome = Opened | <Unavailable>;

  -- Spawn 的结局：起来了就交回身份
  SpawnOutcome = Identity | <Failed>;

  -- 操作系统的事实
state Os of
  open    : map Enclosure to Capability      -- 开着的围栏与各自的能力
  members : map Enclosure to set of Identity -- 每个围栏此刻的成员
  alive   : map Identity to Usage            -- 活着的进程与各自此刻的用量
  charged : map Enclosure to Usage           -- 已退出成员留在围栏里的累计用量
  inv mk_Os(o, m, a, c) ==
    dom m = dom o and dom c = dom o
    and (forall e in set dom m & m(e) subset dom a)
    and (forall e1, e2 in set dom m & e1 <> e2 => m(e1) inter m(e2) = {})
  init s == s = mk_Os({|->}, {|->}, {|->}, {|->})
end

operations
  -- 开一个新围栏；开不出来时什么都不变
  Open() r: OpenOutcome
  ext wr open wr members wr charged
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

  -- 按父子关系或宿主留下的标记推断与锚点有关的活着的进程；锚点自身不在结果里
  Related(anchors: set of Identity) r: set of Identity
  ext rd alive
  post r subset dom alive and r inter anchors = {};

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

  -- 终止一个进程；按身份操作，进程号已被复用时不影响新进程；之后它的 Vanish 事件发生
  Terminate(id: Identity)
  ext wr alive wr members wr charged
  post alive = {id} <-: alive~
    and (forall e in set dom members &
          members(e) = members~(e) \ {id}
          and charged(e) = (if id in set members~(e) then Add(charged~(e), alive~(id)) else charged~(e)));

  -- 终止一个围栏的全部成员
  Kill(enclosure: Enclosure)
  ext wr alive wr members wr charged
  pre enclosure in set dom members
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

  -- 场景：宿主退出前处置自己的围栏；内核保证的围栏留给内核，宿主配合的围栏先终止成员再关闭
  Abandon: Enclosure ==> ()
  Abandon(enclosure) ==
    cases open(enclosure).guarantee:
      <Kernel> -> skip,
      <Cooperative> -> (Kill(enclosure); Close(enclosure))
    end
  pre enclosure in set dom open;
end Platform
```
