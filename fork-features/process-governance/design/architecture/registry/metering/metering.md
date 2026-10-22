# 计量连接

```vdm
module Metering
imports
  from Platform
    types
      Identity renamed Identity;
      Enclosure renamed Enclosure;
      Usage renamed Usage
    functions
      Total: set of Identity * map Identity to Usage -> Usage renamed Total
    operations
      ProbeAll: set of Identity ==> map Identity to Usage;
      Measure: Enclosure ==> Usage,
  from Registry
    types
      UnitId renamed UnitId;
      FenceOutcome renamed FenceOutcome
    operations
      Own: UnitId ==> FenceOutcome;
      Processes: UnitId ==> set of Identity
exports
  types struct Coverage; struct Reading
  operations
    Note: Reading ==> ();
    Sample: UnitId ==> Reading;
    Last: UnitId ==> [Reading]
definitions
types
  -- 读数覆盖的范围
  Coverage = <Complete> | <LiveOnly>;
  -- <Complete>: 含已退出成员
  -- <LiveOnly>: 只含采样那一刻活着的进程

  -- 一个单位的一次读数
  Reading ::
    unit     : UnitId    -- 读的是哪个单位
    usage    : Usage     -- 读到的用量
    coverage : Coverage; -- 这份读数覆盖的范围

  -- 账本
state Ledger of
  last : map UnitId to Reading  -- 每个单位最近一次读数
  inv l == forall u in set dom l.last & l.last(u).unit = u
  init l == l = mk_Ledger({|->})
end

operations
  -- 记下一个单位最近一次读数；只保留最近一次
  Note(r: Reading)
  ext wr last
  post last = last~ ++ {r.unit |-> r};
  -- 场景：取回一个单位此刻的读数；单位自己开了围栏时读围栏，否则逐个读登记在册的进程
  Sample: UnitId ==> Reading
  Sample(unit) ==
    let own = Registry`Own(unit) in
      if own = <Unfenced> then
        let ids = Registry`Processes(unit) in
          let probes = Platform`ProbeAll(ids) in
            let r = mk_Reading(unit, Total(dom probes, probes), <LiveOnly>) in
              (Note(r); return r)
      else
        let usage = Platform`Measure(own.enclosure) in
          let r = mk_Reading(unit, usage, if own.capability.aggregate then <Complete> else <LiveOnly>) in
            (Note(r); return r);
  -- 一个单位最近一次读数；没有采过样时为空
  Last(unit: UnitId) r: [Reading]
  ext rd last
  post r = (if unit in set dom last then last(unit) else nil);
end Metering
```
