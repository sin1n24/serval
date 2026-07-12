/* ============================================================
 * WinMeter 評価エンジン（engine.py の移植・純関数）
 * かわロボ「1本」ハザードモデル + Elo/h2h 事前シェア。
 * すべての調整値は WME.PARAMS に集約（コンソールから変更可能）。
 * 照合値は engine.py 実行結果（wm_engine.test.js 参照）。
 * ============================================================ */
var WME = (function(){
  var PARAMS = {
    LAMBDA_FALLBACK: 1/60,   // ratings.json 不在時の1本発生率/秒
    CLAMP: [0.05, 0.95],     // 表示勝率の範囲（0%/100%は出さない）
    DRAW_COIN: 0.5,          // 判定（≒コイントス）の勝率
    W_H2H: 0.3,              // 直接対決項の重み
    H2H_PRIOR: 2,            // h2h平滑化の仮想本数（片側）
    HALF_LIFE: 8,            // 手動モメンタム半減期（秒）
    HALF_LIFE_KD: 60,        // ダウン奪取モメンタム半減期（秒）
    MOM_MANUAL: 0.4,         // 攻勢ボタンの加算
    MOM_KNOCKDOWN: 0.3,      // ダウン奪取実績の加算
    C_RECOVER: 0.067,        // ダウン1カウントあたり復帰確率
    ROUND_SEC: 120           // 1ラウンド秒数（試合時間設定に連動して上書き）
  };

  function sigmoid(x){ return 1/(1+Math.exp(-x)); }

  /* 事前シェアのロジット。elo差 + 平滑化h2h の加重和（engine.py round_share と同式） */
  function preLogit(eloA, eloB, ptsA, ptsB){
    var eloL = (eloA-eloB)/400*Math.LN10;
    var h2hL = Math.log((ptsA+PARAMS.H2H_PRIOR)/(ptsB+PARAMS.H2H_PRIOR));
    return (1-PARAMS.W_H2H)*eloL + PARAMS.W_H2H*h2hL;
  }

  /* ラウンドの (A勝ち, B勝ち, 引き分け) 確率。残り時間 t 秒 */
  function roundOutcome(share, lam, t){
    var pd = 1-Math.exp(-lam*Math.max(0,t));
    return [share*pd, (1-share)*pd, 1-pd];
  }

  /* 試合全体のA勝率（engine.py match_win_prob の移植）。
   * bestOf=1: 予選（1本先取・引き分け→判定）
   * bestOf=3: 決勝（2本先取・最大3R+延長1R・未決着→判定）
   * score=[a,b] 現在の本数 / tRemain 進行中ラウンドの残り秒 / inRound ラウンド進行中か */
  function matchWinProb(share, lam, bestOf, score, tRemain, inRound){
    var qo = roundOutcome(share, lam, tRemain);
    var qa = qo[0], qb = qo[1], qd = qo[2];
    if(bestOf === 1){
      if(score && score[0] >= 1) return 1;   // 1本先取：既に取れば決着（ダウン補正の分岐用）
      if(score && score[1] >= 1) return 0;
      return qa + PARAMS.DRAW_COIN*qd;
    }

    var a0 = score[0], b0 = score[1];
    var used = a0 + b0;   // 引き分けRも本来消費するが本数のみ管理（engine.py と同じ近似）

    function after(a, b, left, ext){
      if(a >= 2) return 1;
      if(b >= 2) return 0;
      var fo = roundOutcome(share, lam, PARAMS.ROUND_SEC);
      if(left <= 0){
        if(ext > 0)  // 延長は1本勝負: 取れば勝ち、引き分けなら判定
          return a === b ? fo[0] + PARAMS.DRAW_COIN*fo[2] : (a > b ? 1 : 0);
        return a === b ? PARAMS.DRAW_COIN : (a > b ? 1 : 0);
      }
      return fo[0]*after(a+1, b, left-1, ext)
           + fo[1]*after(a, b+1, left-1, ext)
           + fo[2]*after(a, b, left-1, ext);
    }

    if(inRound){
      var left = Math.max(0, 3-used-1);
      return qa*after(a0+1, b0, left, 1)
           + qb*after(a0, b0+1, left, 1)
           + qd*after(a0, b0, left, 1);
    }
    return after(a0, b0, Math.max(0, 3-used), 1);
  }

  function clampP(p){ return Math.min(Math.max(p, PARAMS.CLAMP[0]), PARAMS.CLAMP[1]); }

  /* ダウン補正。downs=[nA|null, nB|null]（現在のカウント数1〜9、無ければnull）。
   * pFail=(1-C_RECOVER)^(10-n) で復帰失敗（=相手の1本）確率を混合。
   * 両者同時ダウンは独立に扱い、同時失敗は各1本のコイン混合で近似。 */
  function downAdjusted(share, lam, bestOf, score, tRemain, inRound, downs){
    var base = function(sc){ return matchWinProb(share, lam, bestOf, sc, tRemain, inRound); };
    var nA = downs && downs[0], nB = downs && downs[1];
    var pFA = nA != null ? Math.pow(1-PARAMS.C_RECOVER, Math.max(1, 10-nA)) : 0;
    var pFB = nB != null ? Math.pow(1-PARAMS.C_RECOVER, Math.max(1, 10-nB)) : 0;
    if(!pFA && !pFB) return base(score);
    var scoreBp = [score[0]+1, score[1]];   // Aが1本取った後
    var scoreAp = [score[0], score[1]+1];   // Bが1本取った後
    return pFA*pFB   * 0.5*(base(scoreBp)+base(scoreAp))
         + pFA*(1-pFB) * base(scoreAp)      // A復帰失敗 → Bに1本
         + (1-pFA)*pFB * base(scoreBp)      // B復帰失敗 → Aに1本
         + (1-pFA)*(1-pFB) * base(score);
  }

  /* モメンタム値の指数減衰。v: 現在値, dtSec: 経過秒（戦闘時間）, hl: 半減期秒 */
  function decay(v, dtSec, hl){ return v*Math.pow(0.5, Math.max(0,dtSec)/hl); }

  /* ライブシェア: 事前ロジットにモメンタム差を加算 */
  function liveShare(logit0, momA, momB){ return sigmoid(logit0 + momA - momB); }

  /* engine.py 実行結果との照合。全て一致で true */
  function selfTest(){
    var lam = 0.0544, EPS = 1e-4;
    var cases = [
      [matchWinProb(0.6, lam, 1, [0,0],   3, true ), 0.515058, '予選 t=3'],
      [matchWinProb(0.6, lam, 1, [0,0], 120, false), 0.599854, '予選 事前'],
      [matchWinProb(0.6, lam, 3, [1,0], 120, false), 0.840000, '決勝 (1,0)'],
      [matchWinProb(0.6, lam, 3, [0,0], 120, false), 0.647999, '決勝 事前'],
      [matchWinProb(0.6, lam, 3, [1,1],  60, true ), 0.599994, '決勝 (1,1) t=60'],
      [matchWinProb(0.5, lam, 1, [0,0], 120, false), 0.5,      '五分'],
      [sigmoid(preLogit(1581.5, 1572.6, 2, 1)),      0.530504, 'share照合']
    ];
    var ok = true;
    cases.forEach(function(c){
      var pass = Math.abs(c[0]-c[1]) < EPS;
      if(!pass) ok = false;
      console.log((pass?'PASS':'FAIL')+' '+c[2]+': got '+c[0].toFixed(6)+' want '+c[1].toFixed(6));
    });
    return ok;
  }

  return { PARAMS: PARAMS, sigmoid: sigmoid, preLogit: preLogit, roundOutcome: roundOutcome,
           matchWinProb: matchWinProb, clampP: clampP, downAdjusted: downAdjusted,
           decay: decay, liveShare: liveShare, selfTest: selfTest };
})();
if(typeof module!=='undefined' && module.exports) module.exports = WME;
