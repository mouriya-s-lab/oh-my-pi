# 登记连接

```vdm
module Registry
imports from Governance
  types
    Identity renamed Identity;
    Mark renamed Mark;
    Enclosure renamed Enclosure
exports
  types UnitId; struct Membership; struct Entry
  functions
    Ancestors: UnitId * map UnitId to UnitId * nat -> set of UnitId;
    Of: UnitId * map Mark to UnitId * map Identity to Entry -> set of Identity
  operations
    Begin: [UnitId] ==> UnitId;
    Claim: UnitId ==> Mark;
    Record: Identity * Mark * Membership * [Enclosure] ==> ();
    Processes: UnitId ==> set of Identity;
    Enclosures: UnitId ==> set of Enclosure;
    Marks: UnitId ==> set of Mark;
    Drop: Identity ==> ();
    End: UnitId ==> ()
definitions
types
  -- 一个归属单位的身份；登记方造出，使用方不读结构
  UnitId = token;

  -- 宿主怎样认出这个进程是自己的
  Membership = <Spawned> | <Enclosed> | <Marked>;
  -- <Spawned>: 宿主亲手起的
  -- <Enclosed>: 在宿主自己的围栏里发现的
  -- <Marked>: 在围栏外按标记认出的

  -- 一条登记：每个进程带着它血统的标记；在围栏里发现的一定写围栏，按标记认出的一定不在围栏里
  Entry ::
    mark       : Mark          -- 它血统的标记，由起它的那次 spawn 盖下
    membership : Membership    -- 宿主怎样认出它
    enclosure  : [Enclosure]   -- 它所在的围栏；不在围栏里为空
  inv e ==
    (e.membership = <Enclosed> => e.enclosure <> nil)
    and (e.membership = <Marked> => e.enclosure = nil);

  -- 登记表
state Table of
  units   : set of UnitId          -- 活着的单位
  parent  : map UnitId to UnitId   -- 内层单位到它的外层；构成森林
  marks   : map Mark to UnitId     -- 每个标记是替哪个单位盖的
  entries : map Identity to Entry  -- 登记在册的进程
  inv mk_Table(u, p, m, en) ==
    dom p subset u and rng p subset u
    and (forall x in set dom p & x not in set Ancestors(x, p, card dom p))
    and rng m subset u
    and (forall id in set dom en & en(id).mark in set dom m)
    and (forall a, b in set dom en &
          en(a).enclosure <> nil and en(a).enclosure = en(b).enclosure => en(a).mark = en(b).mark)
  init t == t = mk_Table({}, {|->}, {|->}, {|->})
end

functions
  -- 一个单位向上最多 fuel 层的全部外层；fuel 取单位数时足以走完任何无环链，也足以让环回到起点
  Ancestors: UnitId * map UnitId to UnitId * nat -> set of UnitId
  Ancestors(u, p, fuel) ==
    if fuel = 0 or u not in set dom p then {}
    else {p(u)} union Ancestors(p(u), p, fuel - 1)
  measure Fuel;

  -- Ancestors 的递归度量
  Fuel: UnitId * map UnitId to UnitId * nat -> nat
  Fuel(-, -, fuel) == fuel;

  -- 一个单位名下登记在册的全部进程：标记是替它盖的那些
  Of: UnitId * map Mark to UnitId * map Identity to Entry -> set of Identity
  Of(unit, marks, entries) ==
    {id | id in set dom entries & marks(entries(id).mark) = unit}
  pre forall id in set dom entries & entries(id).mark in set dom marks;

operations
  -- 开始一个单位；没有外层就是根，否则嵌在一个活着的外层里
  Begin(outer: [UnitId]) r: UnitId
  ext wr units wr parent
  pre outer <> nil => outer in set units
  post r not in set units~
    and units = units~ union {r}
    and parent = (if outer = nil then parent~ else parent~ ++ {r |-> outer});

  -- 替一个单位盖一个新标记；之后用它起进程
  Claim(unit: UnitId) r: Mark
  ext wr marks rd units
  pre unit in set units
  post r not in set dom marks~ and marks = marks~ ++ {r |-> unit};

  -- 记下一个进程；同一身份只登记一次；标记必须已替某个单位盖过；同一围栏里的进程共用标记
  Record(id: Identity, mark: Mark, membership: Membership, within: [Enclosure])
  ext wr entries rd marks
  pre id not in set dom entries
      and mark in set dom marks
      and (membership = <Enclosed> => within <> nil)
      and (membership = <Marked> => within = nil)
      and (forall other in set dom entries & entries(other).enclosure = within and within <> nil => entries(other).mark = mark)
  post entries = entries~ ++ {id |-> mk_Entry(mark, membership, within)};

  -- 一个单位名下登记在册的进程
  Processes(unit: UnitId) r: set of Identity
  ext rd marks rd entries
  post r = Of(unit, marks, entries);

  -- 一个单位名下进程所在的全部围栏
  Enclosures(unit: UnitId) r: set of Enclosure
  ext rd marks rd entries
  post r = {entries(id).enclosure | id in set Of(unit, marks, entries) & entries(id).enclosure <> nil};

  -- 替一个单位盖过的全部标记
  Marks(unit: UnitId) r: set of Mark
  ext rd marks
  post r = {m | m in set dom marks & marks(m) = unit};

  -- 进程已不存在，登记随之撤销；撤销两次与一次效果相同
  Drop(id: Identity)
  ext wr entries
  post entries = {id} <-: entries~;

  -- 结束一个单位；内层已全部结束，名下没有登记；替它盖的标记随之作废
  End(unit: UnitId)
  ext wr units wr parent wr marks rd entries
  pre unit in set units
      and unit not in set rng parent
      and Of(unit, marks, entries) = {}
  post units = units~ \ {unit}
    and parent = {unit} <-: parent~
    and marks = {m | m in set dom marks~ & marks~(m) = unit} <-: marks~;
end Registry
```
