# -*- coding: utf-8 -*-
"""
かわロボ優勢評価エンジン フェーズ1プロトタイプ
- servalブラケットJSONの解析
- 操縦者(代表者)Elo + ハザード(1本発生率)モデル
- 事前勝率の計算(1本先取 / 2本先取+延長+判定)

データ仕様(実データで検証済み):
- results[key].win: 0 = 上側スロット(赤)の勝ち, 1 = 下側スロット(青)の勝ち
- games[].elapsed: 2:00カウントダウンの残り時間 → ラウンド実時間 = 120 - elapsed
- kind: 1-0勝ち / 1-1 / 2-0勝ち / 2-1勝ち / 不戦勝 / 勝者なし
"""
import json
import math
from collections import defaultdict

ROUND_SEC = 120.0          # 1ラウンドの時間
DRAW_COIN = 0.5            # 判定≒コイントスの勝率
ELO_K = 32.0               # Elo更新係数(ラウンド単位)
ELO_SCALE = 400.0

# ---------------------------------------------------------------- パース

def _mmss(s):
    if not s:
        return None
    m, sec = s.split(":")
    return int(m) * 60 + int(sec)


def parse_serval(path):
    """servalブラケットJSONから試合記録リストを抽出する。

    返り値: matches = [{
        'key': '1-3', 'round': 1,
        'a': {'name','rep','aff','type1','type2'},  # 上側スロット
        'b': {...},                                  # 下側スロット
        'winner': 'a'|'b',
        'kind': '1-0勝ち'等,
        'score': (winner本数, loser本数) or None,
        'durations': [各ラウンドの実時間秒, ...],
        'order': 進行順ソートキー
    }, ...]
    """
    d = json.load(open(path, encoding="utf-8"))
    matches = []
    for t in d.get("tournaments", []):
        size = t["size"]
        slots = t["slots"]
        results = t.get("results", {})
        n_rounds = int(math.log2(size))

        def player_of(slot):
            if slot is None:
                return None
            p = slot.get("player") if isinstance(slot, dict) else None
            if not p:
                return None
            return {
                "name": p.get("playerName", ""),
                "rep": p.get("representative") or p.get("playerName", ""),
                "aff": p.get("affiliation", ""),
                "type1": p.get("type1", ""),
                "type2": p.get("type2", ""),
            }

        # winner[(round, idx)] を再帰的に解決(bye自動勝ち上がり対応)
        memo = {}

        def participant(r, j):
            """ラウンドr試合jの(上側, 下側)参加者。r=0は仮想的にスロット直参照。"""
            if r == 1:
                return player_of(slots[2 * j]), player_of(slots[2 * j + 1])
            wa = winner_of(r - 1, 2 * j)
            wb = winner_of(r - 1, 2 * j + 1)
            return wa, wb

        def winner_of(r, j):
            key = (r, j)
            if key in memo:
                return memo[key]
            a, b = participant(r, j)
            res = results.get(f"{r}-{j}")
            w = None
            if res is not None and a and b:
                w = a if res["win"] == 0 else b
            elif a and not b:
                w = a  # bye
            elif b and not a:
                w = b
            memo[key] = w
            return w

        for r in range(1, n_rounds + 1):
            for j in range(size // (2 ** r)):
                res = results.get(f"{r}-{j}")
                if res is None:
                    continue
                a, b = participant(r, j)
                if not a or not b:
                    continue
                kind = res.get("kind", "")
                if "不戦" in kind or "勝者なし" in kind:
                    continue  # レーティングには使わない
                durations = []
                order = None
                for g in res.get("games", []):
                    e = _mmss(g.get("elapsed"))
                    if e is not None:
                        durations.append(ROUND_SEC - e)
                    if order is None and g.get("startTime"):
                        order = g["startTime"]
                score = None
                for tok in kind.replace("勝ち", "").split():
                    if "-" in tok:
                        try:
                            w, l = tok.split("-")
                            score = (int(w), int(l))
                        except ValueError:
                            pass
                matches.append({
                    "key": f"{r}-{j}", "round": r,
                    "a": a, "b": b,
                    "winner": "a" if res["win"] == 0 else "b",
                    "kind": kind, "score": score,
                    "durations": durations,
                    "order": order or f"zz-{r}-{j}",
                })
        # 3位決定戦
        res = results.get("3rd")
        if res is not None:
            sf0 = participant(n_rounds - 0, 0)  # 決勝の参加者 = 準決勝勝者
            # 準決勝の敗者を求める
            losers = []
            for j in (0, 1):
                a, b = participant(n_rounds - 1, j)
                rr = results.get(f"{n_rounds - 1}-{j}")
                if rr and a and b:
                    losers.append(b if rr["win"] == 0 else a)
            if len(losers) == 2:
                durations = [ROUND_SEC - _mmss(g["elapsed"])
                             for g in res.get("games", []) if _mmss(g.get("elapsed")) is not None]
                order = next((g["startTime"] for g in res.get("games", []) if g.get("startTime")), "zz-3rd")
                score = None
                for tok in res.get("kind", "").replace("勝ち", "").split():
                    if "-" in tok:
                        try:
                            w, l = tok.split("-")
                            score = (int(w), int(l))
                        except ValueError:
                            pass
                matches.append({
                    "key": "3rd", "round": n_rounds,
                    "a": losers[0], "b": losers[1],
                    "winner": "a" if res["win"] == 0 else "b",
                    "kind": res.get("kind", ""), "score": score,
                    "durations": durations, "order": order,
                })
    matches.sort(key=lambda m: m["order"])
    return matches


# ---------------------------------------------------------------- レーティング

class Ratings:
    """操縦者(代表者)Elo + ロボット補正 + ハザード較正。

    複数大会のmatchesを時系列順にfeed()して育てる。
    """

    def __init__(self):
        self.pilot = defaultdict(lambda: 1500.0)   # rep -> Elo
        self.robot_off = defaultdict(float)        # robot name -> オフセット(将来拡張)
        self.n_games = defaultdict(int)
        self.total_points = 0                      # 決着したラウンド数
        self.total_time = 0.0                      # 戦闘総時間
        self.h2h = defaultdict(lambda: [0, 0])     # (repA,repB)ソート済 -> [A勝ラウンド, B勝ラウンド]

    # -- 学習 --------------------------------------------------------
    def feed(self, matches):
        for m in matches:
            ra, rb = m["a"]["rep"], m["b"]["rep"]
            score = m["score"] or ((1, 0) if m["winner"] else None)
            if score is None:
                continue
            w_pts, l_pts = score
            a_pts = w_pts if m["winner"] == "a" else l_pts
            b_pts = w_pts if m["winner"] == "b" else l_pts
            # ハザード較正: 決着ラウンド数と総時間
            self.total_points += a_pts + b_pts
            self.total_time += sum(m["durations"]) if m["durations"] else (a_pts + b_pts) * 60.0
            # 直接対決
            k = tuple(sorted([ra, rb]))
            if k[0] == ra:
                self.h2h[k][0] += a_pts; self.h2h[k][1] += b_pts
            else:
                self.h2h[k][0] += b_pts; self.h2h[k][1] += a_pts
            # Elo更新(ラウンド単位、同一試合内は一括)
            ea = self._expect(self.pilot[ra], self.pilot[rb])
            n = a_pts + b_pts
            sa = a_pts / n
            self.pilot[ra] += ELO_K * n ** 0.5 * (sa - ea)
            self.pilot[rb] += ELO_K * n ** 0.5 * ((1 - sa) - (1 - ea))
            self.n_games[ra] += n
            self.n_games[rb] += n

    @staticmethod
    def _expect(r1, r2):
        return 1.0 / (1.0 + 10 ** ((r2 - r1) / ELO_SCALE))

    # -- 推論 --------------------------------------------------------
    def base_lambda(self):
        """1秒あたりの1本発生率(両者合計)の全体平均。データ不足時は60秒/本と仮定。"""
        if self.total_points < 5:
            return 1.0 / 60.0
        return self.total_points / max(self.total_time, 1.0)

    def round_share(self, rep_a, rep_b, robot_a=None, robot_b=None,
                    w_h2h=0.3, prior_games=4):
        """Aが「次の1本を取る側」である確率(引き分けを除いた条件付き)。"""
        # Elo項
        la = self.pilot[rep_a] + self.robot_off.get(robot_a, 0.0)
        lb = self.pilot[rep_b] + self.robot_off.get(robot_b, 0.0)
        logit = (la - lb) / ELO_SCALE * math.log(10)
        # 直接対決項(仮想試合で平滑化)
        k = tuple(sorted([rep_a, rep_b]))
        wa, wb = self.h2h[k]
        if k[0] != rep_a:
            wa, wb = wb, wa
        h2h_logit = math.log((wa + prior_games / 2) / (wb + prior_games / 2))
        logit = (1 - w_h2h) * logit + w_h2h * h2h_logit
        return 1.0 / (1.0 + math.exp(-logit))


# ---------------------------------------------------------------- 勝率計算

def round_outcome(share_a, lam_total, t_remain=ROUND_SEC):
    """ラウンドの(A勝ち, B勝ち, 引き分け)確率。"""
    p_decide = 1.0 - math.exp(-lam_total * t_remain)
    return share_a * p_decide, (1 - share_a) * p_decide, 1.0 - p_decide


def match_win_prob(share_a, lam_total, best_of=1, score=(0, 0),
                   t_remain=ROUND_SEC, in_round=True):
    """試合全体のA勝率。

    best_of=1: 予選(1本先取, 延長なし, 引き分け→判定=コイントス)
    best_of=3: 決勝(2本先取, 最大3R + 延長1R, 決まらなければ判定)
    score: 現在の本数 (a, b)
    t_remain: 進行中ラウンドの残り時間(ラウンド間ならROUND_SEC)
    """
    qa, qb, qd = round_outcome(share_a, lam_total, t_remain)
    if best_of == 1:
        return qa + DRAW_COIN * qd

    a0, b0 = score
    rounds_used = a0 + b0  # 引き分けラウンドも本来消費するが本数のみ管理(近似)

    def after(a, b, rounds_left, extension_left):
        if a >= 2:
            return 1.0
        if b >= 2:
            return 0.0
        if rounds_left <= 0:
            if extension_left > 0:
                fa, fb, fd = round_outcome(share_a, lam_total, ROUND_SEC)
                # 延長は1本勝負: 取れば勝ち、引き分けなら判定
                return fa + DRAW_COIN * fd if a == b else (
                    1.0 if a > b else 0.0)
            return DRAW_COIN if a == b else (1.0 if a > b else 0.0)
        fa, fb, fd = round_outcome(share_a, lam_total, ROUND_SEC)
        return (fa * after(a + 1, b, rounds_left - 1, extension_left)
                + fb * after(a, b + 1, rounds_left - 1, extension_left)
                + fd * after(a, b, rounds_left - 1, extension_left))

    rounds_left_after_current = max(0, 3 - rounds_used - (1 if in_round else 0))
    if in_round:
        return (qa * after(a0 + 1, b0, rounds_left_after_current, 1)
                + qb * after(a0, b0 + 1, rounds_left_after_current, 1)
                + qd * after(a0, b0, rounds_left_after_current, 1))
    return after(a0, b0, max(0, 3 - rounds_used), 1)


def prematch(ratings, rep_a, rep_b, robot_a=None, robot_b=None, best_of=1,
             clamp=(0.05, 0.95)):
    """事前勝率。0%/100%回避のためクランプ。"""
    share = ratings.round_share(rep_a, rep_b, robot_a, robot_b)
    lam = ratings.base_lambda()
    p = match_win_prob(share, lam, best_of=best_of, in_round=False)
    return min(max(p, clamp[0]), clamp[1]), share, lam
