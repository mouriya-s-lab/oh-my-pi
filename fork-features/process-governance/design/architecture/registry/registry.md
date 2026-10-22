# 登记连接

```vdm
module Registry
imports from Governance
  types
    Identity renamed Identity;
    UnitId renamed UnitId;
    Enclosure renamed Enclosure
exports
  functions
    Ancestors: UnitId * map UnitId to UnitId * nat -> set of UnitId;
    UnitEnclosures: UnitId * map Enclosure to UnitId -> set of Enclosure;
    UnitUnfenced: UnitId * map Identity to UnitId -> set of Identity
  operations
    Begin: [UnitId] ==> UnitId;
    Attach: UnitId * Enclosure ==> ();
    Track: UnitId * Identity ==> ();
    Enclosures: UnitId ==> set of Enclosure;
    Unfenced: UnitId ==> set of Identity;
    Release: Enclosure ==> ();
    Drop: Identity ==> ();
    End: UnitId ==> ()
definitions
  -- 登记表
state Table of
  units      : set of UnitId             -- 活着的单位
  parent     : map UnitId to UnitId      -- 内层单位到它的外层；构成森林
  enclosures : map Enclosure to UnitId   -- 尚未释放的围栏归哪个单位
  unfenced   : map Identity to UnitId    -- 没有围栏的进程归哪个单位
  inv mk_Table(u, p, e, uf) ==
    dom p subset u and rng p subset u
    and (forall x in set dom p & x not in set Ancestors(x, p, card dom p))
    and rng e subset u
    and rng uf subset u
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

  -- 一个单位名下尚未释放的全部围栏
  UnitEnclosures: UnitId * map Enclosure to UnitId -> set of Enclosure
  UnitEnclosures(unit, enclosures) ==
    {e | e in set dom enclosures & enclosures(e) = unit};

  -- 一个单位名下没有围栏的全部进程
  UnitUnfenced: UnitId * map Identity to UnitId -> set of Identity
  UnitUnfenced(unit, unfenced) ==
    {id | id in set dom unfenced & unfenced(id) = unit};

operations
  -- 开始一个单位；没有外层就是根，否则嵌在一个活着的外层里
  Begin(outer: [UnitId]) r: UnitId
  ext wr units wr parent
  pre outer <> nil => outer in set units
  post r not in set units~
    and units = units~ union {r}
    and parent = (if outer = nil then parent~ else parent~ ++ {r |-> outer});

  -- 把一个新诞生的围栏记在单位名下；同一围栏只登记一次
  Attach(unit: UnitId, enclosure: Enclosure)
  ext wr enclosures rd units
  pre unit in set units and enclosure not in set dom enclosures
  post enclosures = enclosures~ ++ {enclosure |-> unit};

  -- 把一个没有围栏的进程记在单位名下；同一身份只登记一次
  Track(unit: UnitId, id: Identity)
  ext wr unfenced rd units
  pre unit in set units and id not in set dom unfenced
  post unfenced = unfenced~ ++ {id |-> unit};

  -- 一个单位名下尚未释放的围栏；不在册的单位为空集
  Enclosures(unit: UnitId) r: set of Enclosure
  ext rd enclosures
  post r = UnitEnclosures(unit, enclosures);

  -- 一个单位名下没有围栏的进程；不在册的单位为空集
  Unfenced(unit: UnitId) r: set of Identity
  ext rd unfenced
  post r = UnitUnfenced(unit, unfenced);

  -- 围栏已在平台上释放，台账随之撤销；撤销两次与一次效果相同
  Release(enclosure: Enclosure)
  ext wr enclosures
  post enclosures = {enclosure} <-: enclosures~;

  -- 无围栏进程已不存在，台账随之撤销；撤销两次与一次效果相同
  Drop(id: Identity)
  ext wr unfenced
  post unfenced = {id} <-: unfenced~;

  -- 结束一个单位；内层已全部结束，名下没有围栏也没有无围栏进程
  End(unit: UnitId)
  ext wr units wr parent rd enclosures rd unfenced
  pre unit in set units
      and unit not in set rng parent
      and UnitEnclosures(unit, enclosures) = {}
      and UnitUnfenced(unit, unfenced) = {}
  post units = units~ \ {unit}
    and parent = {unit} <-: parent~;
end Registry
```
