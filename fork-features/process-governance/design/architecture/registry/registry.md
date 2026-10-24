# 登记连接

```vdm
module Registry
imports from Governance
  types
    Identity renamed Identity
exports
  types UnitId
  operations
    Begin: [UnitId] ==> UnitId;
    Live: UnitId ==> bool;
    Children: UnitId ==> set of UnitId;
    Attach: UnitId * Identity ==> ();
    Trees: UnitId ==> set of Identity;
    Release: Identity ==> ();
    Alerted: UnitId ==> bool;
    MarkAlerted: UnitId ==> ();
    End: UnitId ==> ()
definitions
types
  -- 一个归属单位的身份；台账造出，使用方不读结构
  UnitId = token;

  -- 宿主内存里的归属与告警台账
state Table of
  units   : set of UnitId            -- 活着的归属单位
  parent  : map UnitId to UnitId     -- 内层单位到它的外层；构成无环森林
  trees   : map Identity to UnitId   -- 尚未释放的受管进程树归哪个单位
  alerted : set of UnitId            -- 存续期内已经触发过超限告警的单位
  inv mk_Table(u, p, t, a) ==
    dom p subset u and rng p subset u
    and (forall x in set dom p & x not in set Ancestors(x, p, card dom p))
    and rng t subset u
    and a subset u
  init s == s = mk_Table({}, {|->}, {|->}, {})
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

  -- 一个单位的直接内层子单位
  UnitChildren: UnitId * map UnitId to UnitId -> set of UnitId
  UnitChildren(unit, parent) ==
    {c | c in set dom parent & parent(c) = unit};

  -- 一个单位名下尚未释放的全部受管进程树
  UnitTrees: UnitId * map Identity to UnitId -> set of Identity
  UnitTrees(unit, trees) ==
    {t | t in set dom trees & trees(t) = unit};

operations
  -- 开始一个单位；没有外层就是根，否则嵌在一个活着的外层里
  Begin(outer: [UnitId]) r: UnitId
  ext wr units wr parent
  pre outer <> nil => outer in set units
  post r not in set units~
    and units = units~ union {r}
    and parent = (if outer = nil then parent~ else parent~ ++ {r |-> outer});

  -- 一个单位是否活着
  Live(unit: UnitId) r: bool
  ext rd units
  post r <=> unit in set units;

  -- 一个单位此刻的直接内层子单位；不在册的单位为空集
  Children(unit: UnitId) r: set of UnitId
  ext rd parent
  post r = UnitChildren(unit, parent);

  -- 把一棵新诞生的受管进程树记在单位名下；同一棵树只登记一次
  Attach(unit: UnitId, tree: Identity)
  ext wr trees rd units
  pre unit in set units and tree not in set dom trees
  post trees = trees~ ++ {tree |-> unit};

  -- 一个单位名下尚未释放的受管进程树；不在册的单位为空集
  Trees(unit: UnitId) r: set of Identity
  ext rd trees
  post r = UnitTrees(unit, trees);

  -- 受管进程树已在平台上释放，台账随之撤销；撤销两次与一次效果相同
  Release(tree: Identity)
  ext wr trees
  post trees = {tree} <-: trees~;

  -- 一个单位在存续期内是否已经触发过超限告警
  Alerted(unit: UnitId) r: bool
  ext rd alerted
  post r <=> unit in set alerted;

  -- 记下这个单位已经触发过超限告警；同一单位重复记与一次效果相同
  MarkAlerted(unit: UnitId)
  ext wr alerted rd units
  pre unit in set units
  post alerted = alerted~ union {unit};

  -- 结束一个单位；直接内层子单位已全部结束，名下受管进程树已全部释放；它的已告警记录随之清除
  End(unit: UnitId)
  ext wr units wr parent wr alerted rd trees
  pre unit in set units
      and UnitChildren(unit, parent) = {}
      and UnitTrees(unit, trees) = {}
  post units = units~ \ {unit}
    and parent = {unit} <-: parent~
    and alerted = alerted~ \ {unit};
end Registry
```
