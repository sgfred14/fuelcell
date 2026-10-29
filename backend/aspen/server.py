"""SOFC Phase 1 plant model (PR-BM property method, near-ideal gas) + optimizer + zero-dependency HTTP server.
Run:  python server.py   ->  http://localhost:8000"""
import json, math, os, itertools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAR = 53.603                     # kW per (kmol/h * V): 2F/3600
LHV = 241.83                     # kJ/mol H2
SP = ['H2', 'H2O', 'O2', 'N2', 'AR']
HF = {'H2O': -241.826}
# Shomate [A,B,C,D,E,F-H]; list of (Tmax_K, coeffs)
SH = {'H2': [(1000, [33.066178, -11.363417, 11.432816, -2.772874, -0.158558, -9.980797]),
             (9e9, [18.563083, 12.257357, -2.859786, 0.268238, 1.97799, -1.147438])],
      'H2O': [(9e9, [30.092, 6.832514, 6.793435, -2.53448, 0.082139, -9.0546])],
      'O2': [(700, [31.32234, -20.23531, 57.86644, -36.50624, -0.007374, -8.903471]),
             (9e9, [30.03235, 8.772972, -3.988133, 0.788313, -0.741599, -11.32468])],
      'N2': [(500, [28.98641, 1.853978, -9.647459, 16.63537, 0.000117, -8.671914]),
             (9e9, [19.50583, 19.88705, -8.598535, 1.369784, 0.527601, -4.935202])]}
CR = {'H2': (33.19, 13.13, -0.216), 'H2O': (647.1, 220.64, 0.3449), 'O2': (154.58, 50.43, 0.0222),
      'N2': (126.2, 33.98, 0.0377), 'AR': (150.86, 48.98, -0.002)}

def cp_h(s, T):  # T in K -> (cp J/mol/K, h kJ/mol absolute)
    if s == 'AR': return 20.786, 0.020786 * (T - 298.15)
    c = next(c for tm, c in SH[s] if T <= tm); t = T / 1000
    cp = c[0] + c[1]*t + c[2]*t**2 + c[3]*t**3 + c[4]/t**2
    h = c[0]*t + c[1]*t**2/2 + c[2]*t**3/3 + c[3]*t**4/4 - c[4]/t + c[5] + HF.get(s, 0)
    return cp, h

# ---- Peng-Robinson with Boston-Mathias alpha (supercritical extrapolation) ----
R_PR = 83.14462618  # cm3 bar / mol K
def _alpha(s, T):
    Tc, Pc, w = CR[s]; m = 0.37464 + 1.54226*w - 0.26992*w*w; Tr = T / Tc
    if Tr <= 1: return (1 + m*(1 - math.sqrt(Tr)))**2
    d = 1 + m/2; c = 1 - 1/d
    return math.exp(c*(1 - Tr**d))
def _a(y, T):
    ai = {s: 0.45724*R_PR**2*CR[s][0]**2/CR[s][1]*_alpha(s, T) for s in y}
    return sum(y[i]*y[j]*math.sqrt(ai[i]*ai[j]) for i in y for j in y)
def pr(y, T, P):
    """returns Z, H_residual (kJ/mol) for mole-fraction dict y"""
    b = sum(y[s]*0.0778*R_PR*CR[s][0]/CR[s][1] for s in y); a = _a(y, T)
    A = a*P/(R_PR*T)**2; B = b*P/(R_PR*T); Z = 1.0
    for _ in range(40):
        f = Z**3 - (1-B)*Z**2 + (A-3*B*B-2*B)*Z - (A*B-B*B-B**3)
        df = 3*Z*Z - 2*(1-B)*Z + (A-3*B*B-2*B)
        Z -= f/df
    dT = 0.05; dadT = (_a(y, T+dT) - _a(y, T-dT))/(2*dT); s2 = math.sqrt(2)
    HR = (R_PR*T*(Z-1) + (T*dadT - a)/(2*s2*b)*math.log((Z+(1+s2)*B)/(Z+(1-s2)*B)))*1e-4
    return Z, HR

def H(n, TC, P, real=True):  # stream enthalpy kW, n: kmol/h dict
    T = TC + 273.15; tot = sum(n.values())
    if tot <= 0: return 0.0
    h = sum(v*cp_h(s, T)[1] for s, v in n.items() if v > 0)
    if real:
        h += tot*pr({s: v/tot for s, v in n.items() if v > 0}, T, P)[1]
    return h/3.6

def Tsolve(n, Htarget, P, lo, hi, real):
    for _ in range(45):
        mid = (lo+hi)/2
        if H(n, mid, P, real) < Htarget: lo = mid
        else: hi = mid
    return (lo+hi)/2

def psat(TC): return 10**(4.6543 - 1435.264/(TC + 273.15 - 64.848))  # bar (273-373 K)
def tdew(P): return 1435.264/(4.6543 - math.log10(P)) + 64.848 - 273.15
def tsat_steam(P): return 1810.94/(8.14019 - math.log10(P*750.062)) - 244.485

DEF = dict(pnet=100., vcell=0.75, uf=0.80, rec=0.50, tin=650., tout=750., j=0.40, area=200., asr=0.25,
           eta_inv=0.965, paux=2.0, qloss=0.015, pst=1.15, pbl=1.25, eta_bl=0.70, eta_rc=0.55, eta_m=0.92,
           tamb=30., rh=0.60, pamb=1.013, psteam=4.013, pinch=10., min_act=0.03, real=1)

BASE = dict(h2_kgh=8.25, lam=11.1, pdc=131.6, p_bl=23.4, p_rc=1.66, t_ab=816., q_fhx=16.5, q_ahx=450.6,
            steam=114.5, t_stack=132.7, eta_el=36.4, eta_chp=66.8, e_exit=0.895, cells=2190, air=89.05)

def plant(F, p):
    re = bool(p['real']); V = p['vcell']; r = p['rec']; Uf = p['uf']; Ti, To, Ps = p['tin'], p['tout'], p['pst']
    Up = Uf*(1-r)/(1-r*Uf); C = Uf*F; Hin = F/(1-r*(1-Up)); Hout = Hin*(1-Up)
    Sin = r*C/(1-r); Sout = Sin + C; o2i = 0.5*C
    an_in = {'H2': Hin, 'H2O': Sin}; an_out = {'H2': Hout, 'H2O': Sout}
    pdc = FAR*C*V; lhv = F*LHV/3.6; ql = p['qloss']*lhv
    qan = H(an_out, To, Ps, re) - H(an_in, Ti, Ps, re) - H({'O2': o2i}, Ti, Ps, re)
    qheat = -qan - pdc - ql
    yw = p['rh']*psat(p['tamb'])/p['pamb']; d = 1 - yw
    ya = {'H2O': yw, 'O2': .2095*d, 'N2': .7808*d, 'AR': .0097*d}
    dh = H(ya, To, Ps, re) - H(ya, Ti, Ps, re); dho = H({'O2': 1}, To, Ps, re) - H({'O2': 1}, Ti, Ps, re)
    N = (qheat + o2i*dho)/dh if dh > 0 else 0
    cath = {s: N*ya[s] for s in ya}; cath['O2'] -= o2i
    # main blower (ideal-gas isentropic + PR departure)
    P1 = p['pamb'] - 0.02; P2 = p['pbl']; T1 = p['tamb'] + 273.15
    cpm = sum(ya[s]*cp_h(s, T1+15)[0] for s in ya)
    ws = N/3.6*cpm*T1*((P2/P1)**(8.314/cpm) - 1)/1000
    sh = ws/p['eta_bl']; pbl = sh/p['eta_m']; Tbl = p['tamb'] + sh*1000/(N/3.6*cpm)
    Zair = pr(ya, Tbl+273.15, P2)[0]
    # recycle blower
    rec = {'H2': r*Hout, 'H2O': r*Sout}; nr = sum(rec.values()); yr = {s: v/nr for s, v in rec.items()}
    cpr = sum(yr[s]*cp_h(s, To+273.15+20)[0] for s in yr)
    wsr = nr/3.6*cpr*(To+273.15)*((P2/Ps)**(8.314/cpr) - 1)/1000
    shr = wsr/p['eta_rc']; prc = shr/p['eta_m']; Trc = To + shr*1000/(nr/3.6*cpr)
    # mixer / fuel preheater
    hmix = H({'H2': F}, 25, P2, re) + H(rec, Trc, P2, re)
    tmix = Tsolve(an_in, hmix, P2, 25, Ti, re)
    q_fhx = H(an_in, Ti, Ps, re) - hmix
    # afterburner
    fin = {s: 0. for s in SP}
    for s, v in cath.items(): fin[s] += v
    ab = {'H2': (1-r)*Hout, 'H2O': (1-r)*Sout}
    for s, v in ab.items(): fin[s] += v
    hab = H(fin, To, Ps, re); fin['H2O'] += fin['H2']; fin['O2'] -= 0.5*fin['H2']; fin['H2'] = 0.
    fl = {s: v for s, v in fin.items() if v > 1e-12}
    t_ab = Tsolve(fl, hab, Ps, To, 2000, re)
    t1 = Tsolve(fl, H(fl, t_ab, Ps, re) - q_fhx, Ps, 100, t_ab, re)
    air = {s: N*ya[s] for s in ya}
    q_ahx = H(air, Ti, Ps, re) - H(air, Tbl, P2, re)
    t2 = Tsolve(fl, H(fl, t1, Ps, re) - q_ahx, Ps, 50, t1, re)
    # HRSG (pinch at saturated-liquid point)
    ts = tsat_steam(p['psteam']); tp = ts + p['pinch']; hf = 4.186*ts; hfg = 2257*((374.15-ts)/274.15)**0.38
    h25 = 4.186*25
    if t2 > tp:
        m = (H(fl, t2, Ps, re) - H(fl, tp, Ps, re))/hfg*3600
        tst = Tsolve(fl, H(fl, tp, Ps, re) - m/3600*(hf-h25), Ps, 20, tp, re)
    else: m, tst = 0., t2
    qst = m/3600*(hf + hfg - h25)
    ywf = fl['H2O']/sum(fl.values()); tdp = tdew(ywf*Ps)
    pac = p['eta_inv']*pdc - p['paux'] - pbl - prc
    # electrochemistry
    I = FAR*1e3*C; cells = I/(p['j']*p['area']); TK = To + 273.15
    po2 = cath['O2']/sum(cath.values())*Ps
    e_exit = 1.2723 - 2.7645e-4*TK + 8.314*TK/(2*96485.33)*math.log((Hout/Sout)*math.sqrt(po2))
    ohm = p['j']*p['asr']; resid = e_exit - V - ohm
    return dict(pac=pac, F=F, h2_kgh=F*2.016, lhv=lhv, pdc=pdc, p_bl=pbl, p_rc=prc, air=N, lam=N*ya['O2']/o2i,
                eta_el=100*pac/lhv, eta_chp=100*(pac+qst)/lhv, t_ab=t_ab, t_flue1=t1, t_flue2=t2, t_stack=tst,
                t_bl=Tbl, t_mix=tmix, t_rc=Trc, q_fhx=q_fhx, q_ahx=q_ahx, q_heat=qheat, q_loss=ql, steam=m, q_steam=qst,
                t_dew=tdp, e_exit=e_exit, ohm=ohm, resid=resid, cells=cells, current_kA=I/1e3, o2_ion=o2i, u_pass=Up,
                z_air=Zair, parasitic=100*(pbl+prc)/pdc, dT=To-Ti,
                streams=[dict(id=i, T=T, P=P_, **{s: round(v.get(s, 0), 3) for s in SP}) for i, T, P_, v in [
                    ('H2-SUP', 25, 6.0, {'H2': F}), ('RECYC', To, Ps, rec), ('ANODE-IN', Ti, Ps, an_in),
                    ('ANODE-OUT', To, Ps, an_out), ('AIR-AMB', p['tamb'], p['pamb'], {s: N*ya[s] for s in ya}),
                    ('O2-ION', Ti, Ps, {'O2': o2i}), ('CATH-OUT', To, Ps, cath), ('FLUE-AB', t_ab, Ps, fl),
                    ('FLUE-1', t1, Ps-.02, fl), ('FLUE-2', t2, Ps-.07, fl), ('FLUE-OUT', tst, Ps-.11, fl)]])

def solve(p):
    p = {**DEF, **{k: float(v) for k, v in p.items() if k in DEF}}
    base_lin = plant(1.0, p); k = base_lin['pac'] + p['paux']  # all T independent of F -> net = F*k - Paux
    F = (p['pnet'] + p['paux'])/k * 1.0
    res = plant(F, p) if k > 0 else base_lin
    res['params'] = p; res['suggestions'] = suggest(res, p); res['baseline'] = BASE
    return res

def suggest(r, p):
    s = []
    if r['resid'] < p['min_act']:
        s.append(dict(sev='crit', msg=f"Voltage margin at anode exit is {r['resid']*1000:.0f} mV (need >= {p['min_act']*1000:.0f} mV for activation + concentration). Lower j to {max(.1, (r['e_exit']-p['vcell']-p['min_act'])/p['asr']):.2f} A/cm2 or cell voltage.",
                      fix=dict(j=round(max(.1, (r['e_exit']-p['vcell']-p['min_act'])/p['asr']), 2))))
    if r['dT'] > 100: s.append(dict(sev='crit', msg=f"Stack dT = {r['dT']:.0f} K exceeds the 100 K thermal-stress window.", fix=dict(tout=p['tin']+100)))
    if r['parasitic'] > 18: s.append(dict(sev='warn', msg=f"Blower parasitic is {r['parasitic']:.1f}% of DC. Raise cell voltage / Uf (less waste heat) or lower blower outlet pressure.", fix=dict(pbl=max(1.18, p['pbl']-.05))))
    if r['t_stack'] < r['t_dew'] + 10: s.append(dict(sev='warn', msg=f"Stack vent {r['t_stack']:.0f} C is within 10 K of flue dew point {r['t_dew']:.0f} C: corrosion risk, reduce steam raising.", fix=None))
    if r['t_ab'] < 700: s.append(dict(sev='warn', msg='Afterburner flame temperature is low for the downstream heat-exchange network.', fix=None))
    if p['uf'] < 0.8 and r['resid'] > p['min_act'] + .02: s.append(dict(sev='tip', msg='Margin is available: raising Uf toward 0.85 saves hydrogen.', fix=dict(uf=min(.85, p['uf']+.05))))
    if not s: s.append(dict(sev='ok', msg='All constraints satisfied. Run Auto-optimize to search for higher efficiency.', fix=None))
    return s

def optimize(p, objective='eta_el'):
    p = {**DEF, **{k: float(v) for k, v in p.items() if k in DEF}}; p['real'] = 0; out = []
    for v, uf, pb, j in itertools.product([.70, .73, .76, .79, .82, .85], [.70, .75, .80, .85, .90], [1.18, 1.25], [.25, .30, .35, .40]):
        q = {**p, 'vcell': v, 'uf': uf, 'pbl': pb, 'j': j}
        try: r = plant((q['pnet']+q['paux'])/(plant(1., q)['pac']+q['paux']), q)
        except Exception: continue
        if r['resid'] < q['min_act'] or r['dT'] > 100 or r['t_stack'] < r['t_dew'] + 10 or r['lam'] < 3: continue
        out.append((r[objective], dict(vcell=v, uf=uf, pbl=pb, j=j), r['eta_el'], r['h2_kgh'], r['cells']))
    out.sort(key=lambda x: -x[0])
    return [dict(score=o[0], params=o[1], eta_el=o[2], h2=o[3], cells=o[4]) for o in out[:5]]

def curves(p):
    res = solve(p); P = res['params']; TK = P['tout'] + 273.15; RT = 8.314*TK/96485.33
    pol = []
    for i in range(0, 61):
        j = i*0.025 + 1e-6; act = 2*RT*math.asinh(j/2.0); conc = -RT/2*math.log(max(1e-6, 1 - j/3.5)); ohm = j*P['asr']
        v = res['e_exit'] - ohm - act - conc
        if v < 0.3: break
        pol.append(dict(j=round(j, 3), v=v, pd=v*j, vs=v*res['cells'], act=act, ohm=ohm, conc=conc, eta=100*v/1.2535*P['uf']))
    sw = []
    for v in [x/100 for x in range(66, 91, 2)]:
        r = solve({**P, 'vcell': v}); sw.append(dict(v=v, eta=r['eta_el'], h2=r['h2_kgh'], lam=r['lam'], par=r['parasitic'], steam=r['steam']))
    return dict(pol=pol, sweep=sw, e_exit=res['e_exit'], j_op=P['j'], v_op=P['vcell'])

class H_(BaseHTTPRequestHandler):
    def _send(self, body, ct='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(200); self.send_header('Content-Type', ct); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send(open(os.path.join(os.path.dirname(__file__), 'index.html'), 'rb').read(), 'text/html; charset=utf-8')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
        fn = {'/api/solve': solve, '/api/curves': curves, '/api/optimize': optimize}.get(self.path)
        try: self._send(fn(body) if fn else {'error': 'not found'})
        except Exception as e: self._send({'error': str(e)})
    def log_message(self, *a): pass

if __name__ == '__main__':
    print('SOFC server on http://localhost:8000'); ThreadingHTTPServer(('0.0.0.0', 8000), H_).serve_forever()
