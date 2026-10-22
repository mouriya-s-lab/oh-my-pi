# 登记连接

```vdm
module Registry
imports from Platform
  types
    Identity renamed Identity;
    Enclosure renamed Enclosure;
    Opened renamed Opened;
    OpenOutcome renamed OpenOutcome;
    Program renamed Program;
    SpawnOutcome renamed SpawnOutcome
  operations
    Open: [Enclosure] ==> OpenOutcome;
    Spawn: Program * [Enclosure] ==> SpawnOutcome;
    Terminate: Identity ==> ();
    Kill: Enclosure ==> ();
    Close: Enclosure ==> ()
exports
  types
    UnitId; struct Kind; struct Policy; struct Membership; struct Entry; struct FenceOutcome; struct LaunchOutcome
  functions
    Outer: Kind * Kind -> bool;
    Killable: Entry -> bool;
    Of: UnitId * map Identity to Entry -> set of Identity;
    Within: FenceOutcome -> [Enclosure]
  operations
    Begin: Kind * [UnitId] ==> UnitId;
    Fence: UnitId * Opened ==> ();
    Fenced: UnitId ==> FenceOutcome;
    Own: UnitId ==> FenceOutcome;
    Record: Identity * UnitId * Policy * Membership * bool ==> ();
    Processes: UnitId ==> set of Identity;
    Drop: Identity ==> ();
    End: UnitId ==> ();
    Start: Kind * [UnitId] ==> UnitId;
    Settle: UnitId ==> ();
    Launch: UnitId * Program * Policy ==> LaunchOutcome;
    Adopt: UnitId * Identity ==> ();
    Observe: UnitId * Identity ==> ();
    Retire: Identity ==> ();
    Seal: UnitId ==> ()
definitions
types
  -- 一个归属单位的身份；登记方造出，使用方不读结构
  UnitId = token;

  -- 归属单位的层级：宿主包含会话，会话包含工具调用
  Kind = <Host> | <Session> | <Call>;

  -- 起进程的一方给出的寿命承诺
  Policy = <Owned> | <Shared> | <Released>;
  -- <Owned>: 随归属单位结束而终止
  -- <Shared>: 多个宿主共用，由它自己按剩余使用方决定退出
  -- <Released>: 有意放走，活过宿主的收尾

  -- 归属的依据
  Membership = <Spawned> | <Enclosed> | <Inferred>;
  -- <Spawned>: 宿主亲手起的
  -- <Enclosed>: exclusive 围栏收纳的
  -- <Inferred>: 从进程表或环境标记推断的

  -- 一条登记：不随单位结束的进程不在围栏里；围栏收纳的一定在围栏里
  Entry ::
    unit       : UnitId      -- 属于哪个归属单位
    policy     : Policy      -- 起进程的一方给出的寿命承诺
    membership : Membership  -- 归属的依据
    inside     : bool        -- 在归属单位的围栏里
  inv e ==
    (e.policy <> <Owned> => not e.inside)
    and (e.membership = <Enclosed> => e.inside);

  -- 查围栏的结局：有围栏，或没有
  FenceOutcome = Opened | <Unfenced>;

  -- Launch 的结局：登记在册的身份，或没起来
  LaunchOutcome = Identity | <Failed>;

  -- 登记表
state Table of
  units   : map UnitId to Kind        -- 活着的单位与各自的层级
  parent  : map UnitId to UnitId      -- 内层单位到它的外层
  fence   : map UnitId to Opened      -- 单位沿用的围栏
  owner   : map Enclosure to UnitId   -- 每个围栏由哪个单位开出
  entries : map Identity to Entry     -- 登记在册的进程
  inv mk_Table(u, p, f, o, en) ==
    dom p subset dom u and rng p subset dom u
    and (forall i in set dom p & Outer(u(p(i)), u(i)))
    and (forall i in set dom u & (u(i) = <Host> <=> i not in set dom p))
    and dom f subset dom u
    and (forall i in set dom f & f(i).enclosure in set dom o)
    and rng o subset dom u
    and (forall id in set dom en &
          en(id).unit in set dom u
          and (en(id).inside => en(id).unit in set dom f))
  init t == t = mk_Table({|->}, {|->}, {|->}, {|->}, {|->})
end

functions
  -- 外层包含内层：宿主包含会话，会话包含工具调用
  Outer: Kind * Kind -> bool
  Outer(outer, inner) ==
    (outer = <Host> and inner = <Session>) or (outer = <Session> and inner = <Call>);

  -- 单位结束时可以终止的登记：承诺随单位结束，且不是推断出来的
  Killable: Entry -> bool
  Killable(e) == e.policy = <Owned> and e.membership <> <Inferred>;

  -- 一个单位名下登记在册的全部进程
  Of: UnitId * map Identity to Entry -> set of Identity
  Of(unit, entries) == {id | id in set dom entries & entries(id).unit = unit};

  -- 查围栏的结局里的围栏本身；没有围栏时为空
  Within: FenceOutcome -> [Enclosure]
  Within(f) ==
    cases f:
      mk_Opened(e, -) -> e,
      <Unfenced> -> nil
    end;

operations
  -- 开始一个单位；宿主没有外层，其余单位嵌在一个活着的外层里；沿用外层的围栏
  Begin(kind: Kind, outer: [UnitId]) r: UnitId
  ext wr units wr parent wr fence
  pre (kind = <Host> <=> outer = nil)
      and (outer <> nil => outer in set dom units and Outer(units(outer), kind))
  post r not in set dom units~
    and units = units~ ++ {r |-> kind}
    and parent = (if outer = nil then parent~ else parent~ ++ {r |-> outer})
    and fence = (if outer <> nil and outer in set dom fence~ then fence~ ++ {r |-> fence~(outer)} else fence~);

  -- 让一个单位改用自己开出的围栏；之后开始的内层沿用它
  Fence(unit: UnitId, opened: Opened)
  ext wr fence wr owner rd units
  pre unit in set dom units and opened.enclosure not in set dom owner
  post fence = fence~ ++ {unit |-> opened}
    and owner = owner~ ++ {opened.enclosure |-> unit};

  -- 一个单位沿用的围栏；不在册的单位没有围栏
  Fenced(unit: UnitId) r: FenceOutcome
  ext rd fence
  post r = (if unit in set dom fence then fence(unit) else <Unfenced>);

  -- 一个单位自己开出的围栏；不在册的单位没有围栏
  Own(unit: UnitId) r: FenceOutcome
  ext rd fence rd owner
  post r = (if unit in set dom fence and owner(fence(unit).enclosure) = unit then fence(unit) else <Unfenced>);

  -- 记下一个进程；同一身份只登记一次
  Record(id: Identity, unit: UnitId, policy: Policy, membership: Membership, inside: bool)
  ext wr entries rd units rd fence
  pre unit in set dom units
      and id not in set dom entries
      and (inside => unit in set dom fence)
      and (policy <> <Owned> => not inside)
      and (membership = <Enclosed> => inside)
  post entries = entries~ ++ {id |-> mk_Entry(unit, policy, membership, inside)};

  -- 一个单位名下登记在册的进程；不在册的单位名下没有进程
  Processes(unit: UnitId) r: set of Identity
  ext rd entries
  post r = Of(unit, entries);

  -- 进程已不存在，登记随之撤销；撤销两次与一次效果相同
  Drop(id: Identity)
  ext wr entries
  post entries = {id} <-: entries~;

  -- 结束一个单位；内层已全部结束，名下没有登记；它开出的围栏随之交还
  End(unit: UnitId)
  ext wr units wr parent wr fence wr owner rd entries
  pre unit in set dom units
      and unit not in set rng parent
      and Of(unit, entries) = {}
  post units = {unit} <-: units~
    and parent = {unit} <-: parent~
    and fence = {unit} <-: fence~
    and owner = {e | e in set dom owner~ & owner~(e) = unit} <-: owner~;

  -- 场景：开始一个单位并尝试给它开自己的围栏
  Start: Kind * [UnitId] ==> UnitId
  Start(kind, outer) ==
    let unit = Begin(kind, outer) in
      (Settle(unit); return unit)
  pre (kind = <Host> <=> outer = nil)
      and (outer <> nil => outer in set dom units and Outer(units(outer), kind));

  -- 场景：在沿用的围栏之内给单位开自己的围栏；开不出来就继续沿用外层的
  Settle: UnitId ==> ()
  Settle(unit) ==
    let within = Within(Fenced(unit)) in
      cases Platform`Open(within):
        mk_Opened(e, c) -> Fence(unit, mk_Opened(e, c)),
        <Unavailable> -> skip
      end
  pre unit in set dom units;

  -- 场景：在一个单位名下起程序并登记；承诺随单位结束的进程起在围栏里，其余起在围栏外
  Launch: UnitId * Program * Policy ==> LaunchOutcome
  Launch(unit, program, policy) ==
    let within = Within(Fenced(unit)) in
      let target = if policy = <Owned> then within else nil in
        let spawned = Platform`Spawn(program, target) in
          if spawned = <Failed> then return <Failed>
          else (Record(spawned, unit, policy, <Spawned>, target <> nil); return spawned)
  pre unit in set dom units;

  -- 场景：把围栏里发现的一个成员收纳到单位名下；exclusive 围栏的成员是收纳的，否则只算推断
  Adopt: UnitId * Identity ==> ()
  Adopt(unit, id) ==
    cases Fenced(unit):
      mk_Opened(-, c) ->
        if c.exclusive then Record(id, unit, <Owned>, <Enclosed>, true)
        else Record(id, unit, <Owned>, <Inferred>, true),
      <Unfenced> -> skip
    end
  pre unit in set dom units and id not in set dom entries;

  -- 场景：把推断出来的一个进程记在单位名下；只记录，不承诺终止
  Observe: UnitId * Identity ==> ()
  Observe(unit, id) == Record(id, unit, <Released>, <Inferred>, false)
  pre unit in set dom units and id not in set dom entries;

  -- 场景：单位收尾时处理一个登记：可终止的终止，然后撤销登记
  Retire: Identity ==> ()
  Retire(id) ==
    if id in set dom entries then
      (if Killable(entries(id)) then Platform`Terminate(id);
       Drop(id));

  -- 场景：单位名下已无登记且内层已结束时，终止并关闭自己开出的围栏，然后结束单位
  Seal: UnitId ==> ()
  Seal(unit) ==
    cases Own(unit):
      mk_Opened(e, -) -> (Platform`Kill(e); Platform`Close(e); End(unit)),
      <Unfenced> -> End(unit)
    end
  pre unit in set dom units and unit not in set rng parent and Of(unit, entries) = {};
end Registry
```
