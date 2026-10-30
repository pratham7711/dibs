import { describe, expect, it } from 'vitest';
import { initialAllocation, reduceEvent, reduceEvents } from '../src/core/reducer.js';
import type { Claim, Drop, DropEvent } from '../src/core/types.js';
const drop: Drop = {id:'d',title:'Test',spots:1,perViewerLimit:1,settleMs:1500,status:'open'};
const open: DropEvent = {type:'DropOpened',at:0,drop};
function claim(id:string,viewer:string,ts:number,received=ts,extra:Partial<Claim>={}): DropEvent { return {type:'ClaimReceived',at:received,messageId:id,viewerId:viewer,login:viewer,display:viewer,isSubscriber:false,twitchTimestamp:ts,receivedAt:received,qty:1,source:'chat',confidence:.97,reason:'dibs',...extra}; }
const events = (...rest:DropEvent[]) => reduceEvents([open,...rest]);
describe('allocator',()=> {
 it('orders by Twitch timestamp, not arrival',()=> { const s=events(claim('a','a',100,100),claim('b','b',50,110)); expect(s.winners[0]?.viewerId).toBe('b'); expect(s.waitlist[0]?.viewerId).toBe('a'); });
 it('displaces latest winner inside settle window',()=> { const s=events(claim('late','late',200,200),claim('early','early',100,300)); expect(s.winners[0]?.viewerId).toBe('early'); expect(s.waitlist[0]?.viewerId).toBe('late'); });
 it('does not displace when grant settle window expired',()=> { const s=events(claim('a','a',200,200),claim('b','b',100,1700)); expect(s.winners[0]?.viewerId).toBe('a'); });
 it('gives subscribers first priority during configured window',()=> { const d={...drop,subsFirstSeconds:5}; const s=reduceEvents([{...open,drop:d},claim('n','n',100,100),claim('s','s',200,200,{isSubscriber:true})]); expect(s.winners[0]?.viewerId).toBe('s'); expect(s.waitlist[0]?.viewerId).toBe('n'); });
 it('enforces per viewer limit',()=> { const d={...drop,spots:3,perViewerLimit:1}; const s=reduceEvents([{...open,drop:d},claim('a','a',1),claim('b','a',2)]); expect(s.winners.reduce((n,c)=>n+c.qty,0)).toBe(1); expect(s.decisionLog.at(-1)?.action).toBe('limit_reached'); });
 it('promotes waitlist on cancellation',()=> { const d={...drop,spots:2}; const s=reduceEvents([{...open,drop:d},claim('a','a',1),claim('b','b',2),claim('c','c',3),{type:'ClaimCancelled',at:4,viewerId:'a'}]); expect(s.winners.map(c=>c.viewerId)).toContain('c'); expect(s.decisionLog.some(x=>x.action==='promoted')).toBe(true); });
 it('promotes waitlist on rejection',()=> { const d={...drop,spots:2}; const s=reduceEvents([{...open,drop:d},claim('a','a',1),claim('b','b',2),claim('c','c',3),{type:'ClaimRejected',at:4,viewerId:'a'}]); expect(s.winners.map(c=>c.viewerId)).toContain('c'); });
 it('ignores duplicate message ids',()=> { const s=events(claim('same','a',1),claim('same','b',2)); expect(s.winners).toHaveLength(1); expect(s.decisionLog.at(-1)?.action).toBe('duplicate_ignored'); });
 it('never oversells',()=> { const d={...drop,spots:2,perViewerLimit:3}; const s=reduceEvents([{...open,drop:d},claim('a','a',1,1,{qty:3}),claim('b','b',2,2,{qty:3}),claim('c','c',3,3,{qty:3})]); expect(s.winners.reduce((n,c)=>n+c.qty,0)).toBeLessThanOrEqual(d.spots); });
 it('routes ambiguous claims to review, never grants automatically',()=> { const s=events(claim('x','x',1,1,{confidence:.6})); expect(s.reviewQueue).toHaveLength(1); expect(s.winners).toHaveLength(0); });
 it('records a reason for every decision',()=> { const s=events(claim('x','x',1)); expect(s.decisionLog.every(d=>d.why.length>0)).toBe(true); });
});
