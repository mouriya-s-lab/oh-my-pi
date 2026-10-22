# 登记连接

```vdm
module Registry
imports from Governance
  types
    Identity renamed Identity;
    Enclosure renamed Enclosure;
    Opened renamed Opened
exports
  types UnitId; struct Policy; struct Membership; struct Entry; struct FenceOutcome
  functions
    Killable: Entry -> bool;
    Of: UnitId * map Identity to Entry -> set of Identity;
    Fences: map UnitId to Opened -> set of Enclosure
  operations
    Begin: [UnitId] ==> UnitId;
    Fence: UnitId * Opened ==> ();
    Own: UnitId ==> FenceOutcome;
    Record: Identity * UnitId * Policy * Membership * [Enclosure] ==> ();
    Processes: UnitId ==> set of Identity;
    Fenced: Enclosure ==> set of Identity;
    Drop: Identity ==> ();
    End: UnitId ==> ()
definitions
types
  -- 一个归属单位的身份；登记方造出，使用方不读结构
  UnitId = token;

  -- 起进程的一方给出的寿命承诺
  Policy = <Owned> | <Shared> | <Released>;
  -- <Owned>: 随归属单位结束而终止
  -- <Shared>: 多个宿主共用，由它自己按剩余使用方决定退出
  -- <Released>: 有意放走，活过宿主的收尾

  -- 归属的依据
  Membership = <Spawned> | <Enclosed> | <Inferred>;
  -- <Spawned>: 宿主亲手起的
  -- <Enclosed>: 围栏收纳的
  -- <Inferred>: 从进程表或环境标记推断的

  -- 一条登记：不随单位结束的进程不写围栏；围栏收纳的一定写围栏
  Entry ::
    unit       : UnitId       -- 属于哪个归属单位
    policy     : Policy       -- 起进程的一方给出的寿命承诺
    membership : Membership   -- 归属的依据
    fence      : [Enclosure]  -- 放在哪个围栏里；不在围栏里为空
  inv e ==
    (e.policy <> <Owned> => e.fence = nil)
    and (e.membership = <Enclosed> => e.fence <> nil);

  -- 查围栏的结局：有自己的围栏，或没有
  FenceOutcome = Opened | <Unfenced>;

  -- 登记表
state Table of
  units   : set of UnitId             -- 活着的单位
  parent  : map UnitId to UnitId      -- 内层单位到它的外层
  fence   : map UnitId to Opened      -- 单位自己开出的围栏
  entries : map Identity to Entry     -- 登记在册的进程
  inv mk_Table(u, p, f, en) ==
    dom p subset u and rng p subset u
    and dom f subset u
    and (forall a, b in set dom f & f(a).enclosure = f(b).enclosure => a = b)
    and (forall id in set dom en &
          en(id).unit in set u
          and (en(id).fence <> nil => en(id).fence in set Fences(f)))
  init t == t = mk_Table({}, {|->}, {|->}, {|->})
end

functions
  -- 单位结束时可以终止的登记：承诺随单位结束，且不是推断出来的
  Killable: Entry -> bool
  Killable(e) == e.policy = <Owned> and e.membership <> <Inferred>;

  -- 一个单位名下登记在册的全部进程
  Of: UnitId * map Identity to Entry -> set of Identity
  Of(unit, entries) == {id | id in set dom entries & entries(id).unit = unit};

  -- 活着的单位开出的全部围栏
  Fences: map UnitId to Opened -> set of Enclosure
  Fences(f) == {f(u).enclosure | u in set dom f};

operations
  -- 开始一个单位；没有外层就是根，否则嵌在一个活着的外层里
  Begin(outer: [UnitId]) r: UnitId
  ext wr units wr parent
  pre outer <> nil => outer in set units
  post r not in set units~
    and units = units~ union {r}
    and parent = (if outer = nil then parent~ else parent~ ++ {r |-> outer});

  -- 记下单位自己开出的围栏；一个单位至多一个，一个围栏至多归一个单位
  Fence(unit: UnitId, opened: Opened)
  ext wr fence rd units
  pre unit in set units and unit not in set dom fence and opened.enclosure not in set Fences(fence)
  post fence = fence~ ++ {unit |-> opened};

  -- 一个单位自己开出的围栏；没开过或不在册时为没有
  Own(unit: UnitId) r: FenceOutcome
  ext rd fence
  post r = (if unit in set dom fence then fence(unit) else <Unfenced>);

  -- 记下一个进程；同一身份只登记一次；写明的围栏必须是某个活着的单位开出的
  Record(id: Identity, unit: UnitId, policy: Policy, membership: Membership, within: [Enclosure])
  ext wr entries rd units rd fence
  pre unit in set units
      and id not in set dom entries
      and (within <> nil => within in set Fences(fence))
      and (policy <> <Owned> => within = nil)
      and (membership = <Enclosed> => within <> nil)
  post entries = entries~ ++ {id |-> mk_Entry(unit, policy, membership, within)};

  -- 一个单位名下登记在册的进程；不在册的单位名下没有进程
  Processes(unit: UnitId) r: set of Identity
  ext rd entries
  post r = Of(unit, entries);

  -- 登记在某个围栏里的进程
  Fenced(enclosure: Enclosure) r: set of Identity
  ext rd entries
  post r = {id | id in set dom entries & entries(id).fence = enclosure};

  -- 进程已不存在，登记随之撤销；撤销两次与一次效果相同
  Drop(id: Identity)
  ext wr entries
  post entries = {id} <-: entries~;

  -- 结束一个单位；内层已全部结束，名下没有可终止的登记，别的单位没有进程放在它的围栏里；剩下的登记与它的围栏随之撤销
  End(unit: UnitId)
  ext wr units wr parent wr fence wr entries
  pre unit in set units
      and unit not in set rng parent
      and (forall id in set Of(unit, entries) & not Killable(entries(id)))
      and (unit in set dom fence =>
            (forall id in set dom entries & entries(id).fence = fence(unit).enclosure => entries(id).unit = unit))
  post units = units~ \ {unit}
    and parent = {unit} <-: parent~
    and fence = {unit} <-: fence~
    and entries = Of(unit, entries~) <-: entries~;
end Registry
```
