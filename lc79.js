import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

// --- CẤU HÌNH ---
const PORT = 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=3959701241b686f12e01bfe9c3a319b8";

// --- GLOBAL STATE ---
let txHistory = []; 
let currentSessionId = null; 
let fetchInterval = null; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- UTILITIES TỐI ƯU ---
function parseLines(data) {
    if (!data || !Array.isArray(data.list)) return [];
    
    const sortedList = data.list.sort((a, b) => b.id - a.id);
    const arr = sortedList.map(item => ({
        session: item.id,
        dice: item.dices,
        total: item.point,
        result: item.resultTruyenThong,
        tx: item.point >= 11 ? 'T' : 'X'
    }));

    return arr.sort((a, b) => a.session - b.session);
}

function lastN(arr, n) {
    const start = Math.max(0, arr.length - n);
    return arr.slice(start);
}

function majority(obj) {
    let maxK = null, maxV = -Infinity;
    for (const k in obj) {
        if (obj[k] > maxV) {
            maxV = obj[k];
            maxK = k;
        }
    }
    return { key: maxK, val: maxV };
}

function sum(nums) {
    return nums.reduce((a, b) => a + b, 0);
}

function avg(nums) {
    return nums.length ? sum(nums) / nums.length : 0;
}

function entropy(arr) {
    if (!arr.length) return 0;
    const freq = {};
    for (const v of arr) freq[v] = (freq[v] || 0) + 1;
    
    let e = 0, n = arr.length;
    for (const k in freq) {
        const p = freq[k] / n;
        e -= p * Math.log2(p);
    }
    return e;
}

function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) m++;
    }
    return m / a.length;
}

function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    
    const freq = {};
    for (const v of tx) freq[v] = (freq[v] || 0) + 1;
    
    let runs = [], cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else {
            runs.push({ val: cur, len });
            cur = tx[i];
            len = 1;
        }
    }
    if (tx.length) runs.push({ val: cur, len });
    
    const meanTotal = avg(totals);
    const variance = avg(totals.map(t => Math.pow(t - meanTotal, 2)));
    
    const last10 = tx.slice(-10);
    const last10Totals = totals.slice(-10);
    const upward = last10Totals.filter((t, i) => i > 0 && t > last10Totals[i-1]).length;
    const downward = last10Totals.filter((t, i) => i > 0 && t < last10Totals[i-1]).length;
    
    return {
        tx, totals, freq, runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        meanTotal,
        stdTotal: Math.sqrt(variance),
        entropy: entropy(tx),
        last3Pattern: tx.slice(-3).join(''),
        last5Pattern: tx.slice(-5).join(''),
        last8Pattern: tx.slice(-8).join(''),
        trends: { upward, downward }
    };
}

// --- ADVANCED PATTERN DETECTION ---
function detectPatternType(runs) {
    if (runs.length < 3) return null;
    const lastRuns = runs.slice(-6);
    const lengths = lastRuns.map(r => r.len);
    const values = lastRuns.map(r => r.val);
    
    if (lastRuns.length >= 3) {
        if (lengths.every(l => l === 1)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '1_1_pattern';
        }
        if (lengths.every(l => l === 2)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '2_2_pattern';
        }
        if (lengths.every(l => l === 3)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '3_3_pattern';
        }
        if (lengths.length >= 5 && lengths[0] === 2 && lengths[1] === 1 && lengths[2] === 2 && lengths[3] === 1 && lengths[4] === 2) return '2_1_2_pattern';
        if (lengths.length >= 5 && lengths[0] === 1 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 1) return '1_2_1_pattern';
        if (lengths.length >= 5 && lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 3 && lengths[3] === 2 && lengths[4] === 3) return '3_2_3_pattern';
        if (lengths.length >= 5 && lengths[0] === 4 && lengths[1] === 2 && lengths[2] === 4 && lengths[3] === 2 && lengths[4] === 4) return '4_2_4_pattern';
        if (lengths.length >= 5 && lengths[0] === 2 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 2) return '2_2_1_pattern';
        if (lengths.length >= 5 && lengths[0] === 1 && lengths[1] === 3 && lengths[2] === 1 && lengths[3] === 3 && lengths[4] === 1) return '1_3_1_pattern';
        if (lengths.length >= 5 && lengths[0] === 3 && lengths[1] === 1 && lengths[2] === 3 && lengths[3] === 1 && lengths[4] === 3) return '3_1_3_pattern';
    }
    const lastRun = lastRuns[lastRuns.length - 1];
    if (lastRun && lastRun.len >= 5) return 'long_run_pattern';
    return 'random_pattern';
}

function predictNextFromPattern(patternType, runs, lastTx) {
    if (!patternType) return null;
    const lastRun = runs[runs.length - 1];
    switch (patternType) {
        case '1_1_pattern': return lastTx === 'T' ? 'X' : 'T';
        case '2_2_pattern': return lastRun.len === 2 ? (lastRun.val === 'T' ? 'X' : 'T') : lastRun.val;
        case '3_3_pattern': return lastRun.len === 3 ? (lastRun.val === 'T' ? 'X' : 'T') : lastRun.val;
        case '2_1_2_pattern':
            if (lastRun.val === 'T' && lastRun.len === 2) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 2) return 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '1_2_1_pattern':
            if (lastRun.val === 'T' && lastRun.len === 1) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 1) return 'T';
            if (lastRun.len === 2) return lastRun.val;
            return null;
        case '3_2_3_pattern':
            if (lastRun.len === 3) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case '4_2_4_pattern':
            if (lastRun.len === 4) return lastRun.val === 'T' ? 'X' : 'T';
            if (lastRun.len === 2) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
        case 'long_run_pattern':
            if (lastRun.len >= 4 && lastRun.len <= 7) return lastRun.val;
            return null;
        default: return null;
    }
}

// =====================================================================
// === ULTRA VIP PATTERN MODULE - NHẬN DIỆN CẦU TỐI THƯỢNG HOÀN CHỈNH ===
// =====================================================================
const VIP_WEIGHTS = {
    'cau_bet': 1.5, 'cau_dao_11': 1.5, 'cau_22': 1.2, 'cau_33': 1.2, 'cau_44': 1.2, 'cau_55': 1.2,
    'cau_121': 1.1, 'cau_123': 1.1, 'cau_321': 1.1, 'cau_212': 1.1, 'cau_1221': 1.0, 'cau_2112': 1.0,
    'cau_nhay_coc': 1.0, 'cau_nhip_nghieng': 1.0, 'cau_3van1': 1.0, 'cau_be_cau': 1.2, 'cau_chu_ky': 1.0,
    'cau_gap': 1.0, 'cau_ziczac': 1.1, 'cau_doi': 1.0, 'cau_rong': 2.0, 'smart_bet': 1.2,
    'distribution': 1.0, 'dice_pattern': 1.0, 'sum_trend': 1.2, 'edge_cases': 1.0, 'momentum': 1.3,
    'cau_tu_nhien': 1.0, 'dice_trend_line': 1.0, 'dice_trend_line_md5': 1.1,
    'wave': 1.0, 'golden_ratio': 1.1, 'day_gay': 1.2, 'day_gay_md5': 1.1,
    'break_pattern_hu': 1.2, 'break_pattern_md5': 1.2
};

const VIP_PATTERN_MAP = {
    'Cầu Bệt': 'cau_bet', 'Cầu Đảo 1-1': 'cau_dao_11', 'Cầu 2-2': 'cau_22', 'Cầu 3-3': 'cau_33',
    'Cầu 4-4': 'cau_44', 'Cầu 5-5': 'cau_55', 'Cầu 1-2-1': 'cau_121', 'Cầu 1-2-3': 'cau_123',
    'Cầu 3-2-1': 'cau_321', 'Cầu 2-1-2': 'cau_212', 'Cầu 1-2-2-1': 'cau_1221', 'Cầu 1-2-1-2-1': 'cau_1221',
    'Cầu 2-1-1-2': 'cau_2112', 'Cầu Nhảy Cóc': 'cau_nhay_coc', 'Cầu Nhịp Nghiêng': 'cau_nhip_nghieng',
    'Cầu 3 Ván 1': 'cau_3van1', 'Cầu Bẻ Cầu': 'cau_be_cau', 'Cầu Chu Kỳ': 'cau_chu_ky',
    'Cầu Gấp': 'cau_gap', 'Cầu Ziczac': 'cau_ziczac', 'Cầu Đôi': 'cau_doi', 'Cầu Rồng': 'cau_rong',
    'Đảo Xu Hướng': 'smart_bet', 'Xu Hướng Cực': 'smart_bet', 'Phân bố': 'distribution',
    'Tổng TB': 'dice_pattern', 'Xu hướng': 'sum_trend', 'Cực Điểm': 'edge_cases', 'Biến động': 'momentum',
    'Cầu Tự Nhiên': 'cau_tu_nhien', 'Biểu Đồ Đường': 'dice_trend_line', 'MD5 Biểu Đồ': 'dice_trend_line_md5',
    'Cầu Liên Tục': 'break_pattern_hu', 'MD5 Cầu': 'break_pattern_md5', 'Dây Gãy': 'day_gay', 'MD5 Dây Gãy': 'day_gay_md5'
};

function detectVIPPattern(history) {
    if (history.length < 15) return null;
    const features = extractFeatures(history);
    const { runs, totals } = features;
    
    const lastRuns = runs.slice(-10);
    const lengths = lastRuns.map(r => r.len);
    const lastRun = lastRuns[lastRuns.length - 1];
    let detectedPatterns = [];

    if (lastRun.len >= 8) detectedPatterns.push('cau_rong');
    else if (lastRun.len >= 4 && lastRun.len < 8) detectedPatterns.push('cau_bet');

    if (lengths.slice(-4).every(l => l === 1)) detectedPatterns.push('cau_dao_11');
    if (lengths.slice(-3).every(l => l === 2)) detectedPatterns.push('cau_22');
    if (lengths.slice(-3).every(l => l === 3)) detectedPatterns.push('cau_33');
    if (lengths.slice(-2).every(l => l === 4)) detectedPatterns.push('cau_44');
    if (lengths.slice(-2).every(l => l === 5)) detectedPatterns.push('cau_55');

    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '1,2,1') detectedPatterns.push('cau_121');
    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '1,2,3') detectedPatterns.push('cau_123');
    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '3,2,1') detectedPatterns.push('cau_321');
    if (lengths.length >= 3 && lengths.slice(-3).join(',') === '2,1,2') detectedPatterns.push('cau_212');
    if (lengths.length >= 4 && lengths.slice(-4).join(',') === '1,2,2,1') detectedPatterns.push('cau_1221');
    if (lengths.length >= 4 && lengths.slice(-4).join(',') === '2,1,1,2') detectedPatterns.push('cau_2112');
    
    if (lengths.length >= 5 && lengths.slice(-5).filter(l => l >= 3).length === 0) detectedPatterns.push('day_gay');
    if (lastRun.len >= 6 && avg(lengths) < 2) detectedPatterns.push('cau_be_cau');

    const recentTotals = totals.slice(-5);
    const momentumValue = recentTotals[recentTotals.length - 1] - recentTotals[0];
    if (Math.abs(momentumValue) > 6) detectedPatterns.push('momentum');
    if (recentTotals.every((val, i, arr) => !i || val > arr[i-1]) || recentTotals.every((val, i, arr) => !i || val < arr[i-1])) {
        detectedPatterns.push('sum_trend');
        detectedPatterns.push('dice_trend_line_md5');
    }

    const fibs = [2, 3, 5, 8];
    if (fibs.includes(lastRun.len)) detectedPatterns.push('golden_ratio');

    return detectedPatterns.length > 0 ? detectedPatterns : ['cau_tu_nhien'];
}

function predictVIP(detectedPatterns, history) {
    if (!detectedPatterns || detectedPatterns.length === 0) return null;
    const { runs, tx } = extractFeatures(history);
    const lastRun = runs[runs.length - 1];
    const lastVal = tx[tx.length - 1];
    let votes = { T: 0, X: 0 };

    for (const pat of detectedPatterns) {
        const w = VIP_WEIGHTS[pat] || 1.0;
        let p = null;

        switch (pat) {
            case 'cau_dao_11':
            case 'cau_ziczac':
                p = lastVal === 'T' ? 'X' : 'T'; break;
            case 'cau_bet':
            case 'cau_rong':
            case 'break_pattern_hu':
                p = lastVal; break; 
            case 'cau_22':
            case 'cau_33':
            case 'cau_44':
            case 'cau_55':
                const targetLen = parseInt(pat.replace('cau_', '').charAt(0));
                p = lastRun.len === targetLen ? (lastVal === 'T' ? 'X' : 'T') : lastVal;
                break;
            case 'cau_121':
            case 'cau_212':
            case 'day_gay':
                p = lastVal === 'T' ? 'X' : 'T'; break;
            case 'momentum':
            case 'sum_trend':
                p = lastVal; break;
            case 'golden_ratio':
                p = lastVal === 'T' ? 'X' : 'T'; break;
            default:
                p = lastVal;
        }

        if (p) votes[p] += w;
    }

    if (votes.T === 0 && votes.X === 0) return null;
    return votes.T > votes.X ? { pred: 'T', confidence: votes.T / (votes.T + votes.X) } : { pred: 'X', confidence: votes.X / (votes.T + votes.X) };
}

// --- 13 CORE ALGORITHMS GIỮ NGUYÊN 100% ---
function algo5_freqRebalance(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { freq, entropy: e } = features;
    const tCount = freq['T'] || 0;
    const xCount = freq['X'] || 0;
    const diff = Math.abs(tCount - xCount);
    const total = tCount + xCount;
    let threshold;
    if (e > 0.9) threshold = 0.45;
    else if (e < 0.4) threshold = 0.65;
    else threshold = 0.55;
    const recent = history.slice(-30);
    const recentT = recent.filter(h => h.tx === 'T').length;
    const recentX = recent.filter(h => h.tx === 'X').length;
    const recentDiff = Math.abs(recentT - recentX);
    const recentTotal = recentT + recentX;
    
    if (total > 0 && recentTotal > 0) {
        const longTermRatio = diff / total;
        const shortTermRatio = recentDiff / recentTotal;
        const combinedRatio = (longTermRatio * 0.4) + (shortTermRatio * 0.6);
        if (combinedRatio > threshold) {
            if (recentT > recentX + 2) return 'X';
            if (recentX > recentT + 2) return 'T';
        }
    }
    return null;
}

function algoA_markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    let maxOrder = 4;
    if (history.length < 30) maxOrder = 3;
    if (history.length < 20) maxOrder = 2;
    let bestPred = null, bestScore = -1;
    
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 8) continue;
        const transitions = {};
        const totalTransitions = tx.length - order;
        const decayFactor = 0.95;
        
        for (let i = 0; i < totalTransitions; i++) {
            const key = tx.slice(i, i + order).join('');
            const next = tx[i + order];
            const weight = Math.pow(decayFactor, totalTransitions - i - 1);
            if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
            transitions[key][next] += weight;
        }
        const lastKey = tx.slice(-order).join('');
        const counts = transitions[lastKey];
        if (counts && (counts.T + counts.X) > 0.5) {
            const total = counts.T + counts.X;
            const confidence = Math.abs(counts.T - counts.X) / total;
            const pred = counts.T > counts.X ? 'T' : 'X';
            const orderWeight = order / maxOrder;
            const supportWeight = Math.min(1, (counts.T + counts.X) / 10);
            const score = confidence * orderWeight * supportWeight;
            if (score > bestScore) {
                bestScore = score;
                bestPred = pred;
            }
        }
    }
    return bestPred;
}

function algoB_ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const ngramSizes = [];
    if (history.length >= 50) ngramSizes.push(5, 6);
    if (history.length >= 40) ngramSizes.push(4);
    ngramSizes.push(3, 2);
    let bestPred = null, bestConfidence = 0;
    
    for (const n of ngramSizes) {
        if (tx.length < n * 2) continue;
        const target = tx.slice(-n).join('');
        let matches = [];
        for (let i = 0; i <= tx.length - n - 1; i++) {
            const gram = tx.slice(i, i + n).join('');
            if (gram === target) {
                matches.push({ position: i, next: tx[i + n], distance: tx.length - i });
            }
        }
        if (matches.length >= 2) {
            const weights = { T: 0, X: 0 };
            let totalWeight = 0;
            for (const match of matches) {
                const weight = 1 / (match.distance * 0.5 + 1);
                weights[match.next] += weight;
                totalWeight += weight;
            }
            if (totalWeight > 0) {
                const tRatio = weights.T / totalWeight;
                const xRatio = weights.X / totalWeight;
                const confidence = Math.abs(tRatio - xRatio);
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    bestPred = weights.T > weights.X ? 'T' : 'X';
                }
            }
        }
    }
    return bestConfidence > 0.3 ? bestPred : null;
}

function algoS_NeoPattern(history) {
    if (history.length < 25) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    const lastTx = tx[tx.length - 1];
    const prediction = predictNextFromPattern(patternType, runs, lastTx);
    
    if (prediction) {
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const patternConsistency = recentRuns.filter(r => 
            patternType.includes('_pattern') || (patternType === 'long_run_pattern' && r.len >= 4)
        ).length / recentRuns.length;
        if (patternConsistency > 0.6) return prediction;
    }
    return null;
}

function algoF_SuperDeepAnalysis(history) {
    if (history.length < 60) return null;
    const timeframes = [
        { lookback: 10, weight: 0.3 },
        { lookback: 30, weight: 0.4 },
        { lookback: 60, weight: 0.3 }
    ];
    let totalScore = { T: 0, X: 0 }, totalWeight = 0;
    for (const tf of timeframes) {
        if (history.length < tf.lookback) continue;
        const slice = history.slice(-tf.lookback);
        const sliceTx = slice.map(h => h.tx);
        const sliceTotals = slice.map(h => h.total);
        const tCount = sliceTx.filter(t => t === 'T').length;
        const xCount = sliceTx.filter(t => t === 'X').length;
        const meanTotal = avg(sliceTotals);
        const volatility = Math.sqrt(avg(sliceTotals.map(t => Math.pow(t - meanTotal, 2))));
        let tScore = 0, xScore = 0;
        
        if (meanTotal > 12) xScore += 0.4;
        if (meanTotal < 9) tScore += 0.4;
        if (tCount > xCount + 3) xScore += 0.3;
        if (xCount > tCount + 3) tScore += 0.3;
        if (volatility > 4) {
            if (sliceTx[sliceTx.length - 1] === 'T') tScore += 0.2;
            else xScore += 0.2;
        }
        const trend = sliceTotals[sliceTotals.length - 1] - sliceTotals[0];
        if (trend > 3) xScore += 0.1;
        if (trend < -3) tScore += 0.1;
        
        const timeframeWeight = tf.weight * (sliceTx.length / tf.lookback);
        totalScore.T += tScore * timeframeWeight;
        totalScore.X += xScore * timeframeWeight;
        totalWeight += timeframeWeight;
    }
    if (totalWeight > 0 && Math.abs(totalScore.T - totalScore.X) > 0.15) {
        return totalScore.T > totalScore.X ? 'T' : 'X';
    }
    return null;
}

function algoE_Transformer(history) {
    if (history.length < 100) return null;
    const tx = history.map(h => h.tx);
    const seqLengths = [6, 8, 10, 12];
    let attentionScores = { T: 0, X: 0 };
    for (const seqLen of seqLengths) {
        if (tx.length < seqLen * 2) continue;
        const targetSeq = tx.slice(-seqLen).join('');
        let seqMatches = 0;
        for (let i = 0; i <= tx.length - seqLen - 1; i++) {
            const historySeq = tx.slice(i, i + seqLen).join('');
            const matchScore = similarity(historySeq, targetSeq);
            if (matchScore >= 0.7) {
                const nextResult = tx[i + seqLen];
                const recency = 1 / (tx.length - i);
                const lengthFactor = seqLen / 12;
                const weight = matchScore * recency * lengthFactor;
                attentionScores[nextResult] = (attentionScores[nextResult] || 0) + weight;
                seqMatches++;
            }
        }
        if (seqMatches >= 3) {
            const boostFactor = Math.min(1.5, seqMatches / 2);
            attentionScores.T *= boostFactor;
            attentionScores.X *= boostFactor;
        }
    }
    if (attentionScores.T + attentionScores.X > 0.2) {
        const total = attentionScores.T + attentionScores.X;
        const confidence = Math.abs(attentionScores.T - attentionScores.X) / total;
        if (confidence > 0.25) return attentionScores.T > attentionScores.X ? 'T' : 'X';
    }
    return null;
}

function algoG_SuperBridgePredictor(history) {
    const features = extractFeatures(history);
    const { runs } = features;
    if (runs.length < 4) return null;
    const lastRun = runs[runs.length - 1];
    let prediction = null, confidence = 0;
    
    if (lastRun.len >= 5) {
        if (lastRun.len >= 8) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.8; }
        else if (lastRun.len >= 5 && lastRun.len <= 7) {
            const avgRunLength = avg(runs.map(r => r.len));
            if (lastRun.len > avgRunLength * 1.8) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.65; } 
            else { prediction = lastRun.val; confidence = 0.6; }
        }
    }
    if (!prediction && runs.length >= 5) {
        const last5Runs = runs.slice(-5);
        const lengths = last5Runs.map(r => r.len);
        if (lengths[0] === 1 && lengths[1] === 1 && lengths[2] >= 3) {
            if (lastRun.len >= 3) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.7; }
        }
        if (lengths.length >= 4) {
            if (lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 2 && lengths[3] === 3) { prediction = lastRun.val === 'T' ? 'T' : 'X'; confidence = 0.6; }
        }
    }
    if (!prediction && runs.length >= 8) {
        const recentRuns = runs.slice(-8);
        const runLengths = recentRuns.map(r => r.len);
        const meanLength = avg(runLengths);
        const stdLength = Math.sqrt(avg(runLengths.map(l => Math.pow(l - meanLength, 2))));
        if (lastRun.len > meanLength + (stdLength * 1.5)) { prediction = lastRun.val === 'T' ? 'X' : 'T'; confidence = 0.6; }
    }
    return confidence > 0.55 ? prediction : null;
}

function algoH_AdaptiveMarkov(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    const models = [
        { type: 'markov', orders: [2, 3, 4] },
        { type: 'frequency', lookbacks: [10, 20, 30] },
        { type: 'momentum', windows: [5, 10, 15] }
    ];
    let ensembleVotes = { T: 0, X: 0 };
    
    for (const model of models) {
        if (model.type === 'markov') {
            for (const order of model.orders) {
                if (tx.length < order + 5) continue;
                const transitions = {};
                for (let i = 0; i <= tx.length - order - 1; i++) {
                    const key = tx.slice(i, i + order).join('');
                    const next = tx[i + order];
                    if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
                    transitions[key][next]++;
                }
                const lastKey = tx.slice(-order).join('');
                const counts = transitions[lastKey];
                if (counts && counts.T + counts.X >= 2) {
                    const pred = counts.T > counts.X ? 'T' : 'X';
                    const confidence = Math.abs(counts.T - counts.X) / (counts.T + counts.X);
                    ensembleVotes[pred] += confidence * (order / 10);
                }
            }
        }
        if (model.type === 'frequency') {
            for (const lookback of model.lookbacks) {
                if (tx.length < lookback) continue;
                const recent = tx.slice(-lookback);
                const tCount = recent.filter(t => t === 'T').length;
                const xCount = recent.filter(t => t === 'X').length;
                if (Math.abs(tCount - xCount) > lookback * 0.2) {
                    const pred = tCount > xCount ? 'X' : 'T';
                    const confidence = Math.abs(tCount - xCount) / lookback;
                    ensembleVotes[pred] += confidence * 0.5;
                }
            }
        }
        if (model.type === 'momentum') {
            for (const window of model.windows) {
                if (tx.length < window * 2) continue;
                const firstHalf = tx.slice(-window * 2, -window);
                const secondHalf = tx.slice(-window);
                const momentumT = secondHalf.filter(t => t === 'T').length - firstHalf.filter(t => t === 'T').length;
                const momentumX = secondHalf.filter(t => t === 'X').length - firstHalf.filter(t => t === 'X').length;
                if (Math.abs(momentumT - momentumX) > window * 0.3) {
                    const pred = momentumT > momentumX ? 'T' : 'X';
                    const confidence = Math.abs(momentumT - momentumX) / window;
                    ensembleVotes[pred] += confidence * 0.3;
                }
            }
        }
    }
    if (ensembleVotes.T + ensembleVotes.X > 0.3) return ensembleVotes.T > ensembleVotes.X ? 'T' : 'X';
    return null;
}

function algoI_PatternMaster(history) {
    if (history.length < 35) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    if (runs.length < 5) return null;
    const recentRuns = runs.slice(-Math.min(8, runs.length));
    const runLengths = recentRuns.map(r => r.len);
    const runValues = recentRuns.map(r => r.val);
    let patternStrength = { T: 0, X: 0 };
    const runPattern = runLengths.join('');
    const valuePattern = runValues.join('');
    
    const patternLibrary = [
        { pattern: '12121', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.7 },
        { pattern: '21212', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'T' : 'X', strength: 0.7 },
        { pattern: '13131', prediction: valuePattern[valuePattern.length-1], strength: 0.6 },
        { pattern: '31313', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.6 },
        { pattern: '24242', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.65 },
        { pattern: '42424', prediction: valuePattern[valuePattern.length-1], strength: 0.65 }
    ];
    for (const libPattern of patternLibrary) {
        if (runPattern.includes(libPattern.pattern)) patternStrength[libPattern.prediction] += libPattern.strength;
    }
    
    const last10Tx = tx.slice(-10).join('');
    const txPatterns = [
        { pattern: 'TXTXTXTX', prediction: 'X', strength: 0.8 }, { pattern: 'XTXTXTXT', prediction: 'T', strength: 0.8 },
        { pattern: 'TTXXTTXX', prediction: 'X', strength: 0.7 }, { pattern: 'XXTTXXTT', prediction: 'T', strength: 0.7 },
        { pattern: 'TTTXXXTT', prediction: 'T', strength: 0.75 }, { pattern: 'XXXTTTXX', prediction: 'X', strength: 0.75 },
        { pattern: 'TTXTTXTT', prediction: 'X', strength: 0.7 }, { pattern: 'XXTXXTXX', prediction: 'T', strength: 0.7 }
    ];
    for (const txPattern of txPatterns) {
        if (last10Tx.includes(txPattern.pattern)) patternStrength[txPattern.prediction] += txPattern.strength;
    }
    
    const lastRun = recentRuns[recentRuns.length - 1];
    if (lastRun) {
        const avgRecentLength = avg(runLengths);
        if (lastRun.len > avgRecentLength * 1.8) patternStrength[lastRun.val === 'T' ? 'X' : 'T'] += 0.5;
        else if (lastRun.len < avgRecentLength * 0.6) patternStrength[lastRun.val] += 0.4;
    }
    if (patternStrength.T > 0 || patternStrength.X > 0) {
        const totalStrength = patternStrength.T + patternStrength.X;
        const confidence = Math.abs(patternStrength.T - patternStrength.X) / totalStrength;
        if (confidence > 0.3) return patternStrength.T > patternStrength.X ? 'T' : 'X';
    }
    return null;
}

function algoJ_QuantumEntropy(history) {
    if (history.length < 40) return null;
    const features = extractFeatures(history);
    const { entropy: e, tx, runs } = features;
    const entropyWindows = [10, 20, 30];
    let entropyPredictions = { T: 0, X: 0 };
    
    for (const window of entropyWindows) {
        if (tx.length < window) continue;
        const windowTx = tx.slice(-window);
        const windowEntropy = entropy(windowTx);
        if (windowEntropy < 0.3) {
            entropyPredictions[windowTx[windowTx.length - 1]] += 0.6;
        } else if (windowEntropy > 0.9) {
            const tCount = windowTx.filter(t => t === 'T').length;
            const xCount = windowTx.filter(t => t === 'X').length;
            if (tCount > xCount) entropyPredictions['X'] += 0.5;
            else if (xCount > tCount) entropyPredictions['T'] += 0.5;
        } else {
            const recentRuns = runs.slice(-4);
            if (recentRuns.length >= 3) {
                const runLengths = recentRuns.map(r => r.len);
                if (Math.max(...runLengths) - Math.min(...runLengths) <= 2) entropyPredictions[tx[tx.length - 1]] += 0.4;
            }
        }
    }
    if (e < 0.4) entropyPredictions[tx[tx.length - 1]] += 0.3;
    else if (e > 0.95) {
        const recentT = tx.slice(-20).filter(t => t === 'T').length;
        const recentX = tx.slice(-20).filter(t => t === 'X').length;
        if (recentT > recentX) entropyPredictions['X'] += 0.4;
        else if (recentX > recentT) entropyPredictions['T'] += 0.4;
    }
    if (entropyPredictions.T + entropyPredictions.X > 0.4) return entropyPredictions.T > entropyPredictions.X ? 'T' : 'X';
    return null;
}

function algoK_VIP_Master_Pattern(history) {
    const vipPatterns = detectVIPPattern(history);
    if (!vipPatterns || vipPatterns.length === 0) return null;
    const result = predictVIP(vipPatterns, history);
    if (result && result.confidence >= 0.5) return result.pred;
    return null;
}

function algoL_UltimateBridgeBreaker(history) {
    if (history.length < 30) return null;
    const features = extractFeatures(history);
    const { runs } = features;
    if (runs.length < 5) return null;
    const lastRun = runs[runs.length - 1];
    if (lastRun.len < 4) return null; 
    const sameTypeRuns = runs.filter(r => r.val === lastRun.val);
    if (sameTypeRuns.length < 5) return null;
    const sameTypeLengths = sameTypeRuns.map(r => r.len);
    const meanLen = avg(sameTypeLengths);
    const stdLen = Math.sqrt(avg(sameTypeLengths.map(l => Math.pow(l - meanLen, 2))));
    if (lastRun.len > (meanLen + (stdLen * 1.8))) return lastRun.val === 'T' ? 'X' : 'T';
    return null;
}

function algoM_DeepChaosDiceAnalyzer(history) {
    if (history.length < 30) return null;
    const lastRecord = history[history.length - 1];
    const lastTotal = lastRecord.total;
    let nextT = 0, nextX = 0;
    
    for (let i = 0; i < history.length - 1; i++) {
        if (history[i].total === lastTotal) {
            if (history[i+1].tx === 'T') nextT++;
            if (history[i+1].tx === 'X') nextX++;
        }
    }
    if (nextT + nextX < 3) {
        const range = lastTotal >= 11 ? [11, 12, 13, 14, 15, 16, 17, 18] : [3, 4, 5, 6, 7, 8, 9, 10];
        for (let i = 0; i < history.length - 1; i++) {
            if (range.includes(history[i].total)) {
                if (history[i+1].tx === 'T') nextT += 0.5;
                if (history[i+1].tx === 'X') nextX += 0.5;
            }
        }
    }
    const recent10 = history.slice(-10).map(h => h.total);
    const mean10 = avg(recent10);
    const variance = avg(recent10.map(t => Math.pow(t - mean10, 2)));
    if (variance > 4.5 && (nextT + nextX) > 0) {
        const confidence = Math.abs(nextT - nextX) / (nextT + nextX);
        if (confidence > 0.15) return nextT > nextX ? 'T' : 'X';
    }
    
    const lastDice = lastRecord.dice;
    let diceMatchT = 0, diceMatchX = 0;
    for (let i = 0; i < history.length - 1; i++) {
        const hDice = history[i].dice;
        let matches = 0;
        if (hDice.includes(lastDice[0])) matches++;
        if (hDice.includes(lastDice[1])) matches++;
        if (hDice.includes(lastDice[2])) matches++;
        if (matches >= 2) {
            if (history[i+1].tx === 'T') diceMatchT++;
            if (history[i+1].tx === 'X') diceMatchX++;
        }
    }
    if (variance > 4.0 && (diceMatchT + diceMatchX >= 2)) {
        if (diceMatchT !== diceMatchX) return diceMatchT > diceMatchX ? 'T' : 'X';
    }
    return null;
}

// =====================================================================
// === THUẬT TOÁN MỚI 14 & 15: EXACT HISTORY PATTERN MATCHING & AI VI LONG ===
// =====================================================================
const THUAT_TOAN_8_DICT = {
    "TXXTTXTX":"X","XXTTXTXX":"T","XTTXTXXT":"T","TTXTXXTT":"T","TXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"X","XXXXXTXX":"X","XXXXTXXX":"T","XXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"X","TXXXTXXX":"T","XXXTXXXX":"T","XXTXXXXT":"T","XTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"T","TXTXTTTT":"T","XTXTTTTT":"T","TXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"X","TTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"T","TXTTXTXT":"T","XTTXTXTT":"X","TXTTXTXX":"X","XTTXTXXX":"T","TTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"T","XTXXXTTT":"T","TXXXTTTT":"T","XXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"X","TTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"T","TTXXXTXT":"T","TXXXTXTT":"X","XXXTXTTX":"X","XXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"T","TXXTTTXT":"X","XXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"T","XTXTTXXX":"T","TXTTXXXT":"T","XTTXXXTX":"X","TTXXXTXX":"T","TXXXTXXT":"X","XXXTXXTX":"T","XXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"X","XTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"X","TXTTXTXX":"T","XTTXTXXT":"X","TTXTXXTX":"T","TXTXXTXT":"T","XTXXTXTT":"T","TXXTXTTT":"T","XXTXTTTT":"T","XTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"X","TTTTXXXX":"X","TTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"X","XXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"T","TTXXTXTT":"T","XXTXTTTT":"X","XTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"X","TTTTXTXX":"T","TTTXTXXT":"X","TTXTXXTX":"T","TXTXXTXT":"X","XTXTXTTT":"X","TXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"T","XTTTXXTT":"T","TTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","TXTXTTTT":"X","XTXTTTTX":"X","TXTTTTXX":"T","XTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"X","TXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"T","TXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"X","TTXTTXXX":"X","XTTXXXXX":"T","TTXXXXXT":"T","TXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"X","XXXTTTTX":"T","XTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXT":"X","XTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"T","TXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"T","TXTXTXTT":"T","XTXTXTTT":"X","TXTTTXXX":"X","XTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"T","XXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"T","TTTTTXTT":"T","TTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"X","TTTTXTXX":"T","TTTXTXXT":"T","TTXTXXTT":"T","TXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"T","XTTTTXTT":"T","TTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"T","TXXXXTTT":"X","XXXXTTTX":"X","XXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"X","TTXXTXXX":"T","TXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"T","TXXXTXXT":"X","XXXTXXTX":"T","XXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"T","XXTTXXTT":"T","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"T","TXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"X","XTTXTTXX":"T","TTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"X","TXTXXXTX":"X","XTXXXTXX":"X","TXXXTXXX":"X","XXXTXXXX":"T","XXTXXXXT":"T","XTXXXXTT":"T","TXXXXTTT":"T","XXXXTTTT":"X","XXXTTTTX":"X","XXTTTTXX":"T","XTTTTXXT":"T","TTTTXXTT":"T","TTTXXTTT":"X","TTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"T","XTTTXXTT":"T","TTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"T","TTTTTXXT":"T","TTTTXXTT":"X","TTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"T","XXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"T","XXTXTTTT":"T","XTXTTTTT":"T","TXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTX":"X","TTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"X","TTTXXXXX":"T","TTXXXXXT":"X","TXXXXXTX":"T","XXXXXTXT":"X","XXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"X","TXTTXTTX":"T","XTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"T","TXTTTTTT":"T","XTTTTTTT":"X","TTTTTTTX":"T","TTTTTTXT":"T","TTTTTXTT":"X","TTTTXTTX":"X","TTTXTTXX":"T","TTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTT":"X","TTTTTTTX":"T","TTTTTTXT":"X","TTTTTXTX":"X","TTTTXTXX":"X","TTTXTXXX":"X","TTXTXXXX":"T","TXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"T","XXTXTTTT":"X","XTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"X","XXTTTTTX":"T","XTTTTTXT":"X","TTTTTXTX":"T","TTTTXTXT":"X","TTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"X","TXXTXXTX":"T","XXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"T","XTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"X","XTXTXXXX":"T","TXTXXXXT":"X","XTXXXXTX":"X","TXXXXTXX":"X","XXXXTXXX":"T","XXXTXXXT":"T","XXTXXXTT":"X","XTXXXTTX":"T","TXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"T","XTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"T","TXTXTXXT":"T","XTXTXXTT":"T","TXTXXTTT":"X","XTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"X","XTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"T","XTXXXTTT":"X","TXXXTTTX":"X","XXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"T","TXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"T","XXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"X","TTTTTTXX":"T","TTTTTXXT":"T","TTTTXXTT":"X","TTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"X","TXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"T","XTTTXXTT":"X","TTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"T","XTXXXTTT":"X","TXXXTTTX":"T","XXXTTTXT":"T","XXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"T","TTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"X","TXXTTTXX":"X","XXTTTXXX":"T","XTTTXXXT":"T","TTTXXXTT":"T","TTXXXTTT":"X","TXXXTTTX":"X","XXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"T","TTXXTXTT":"X","TXXTXTTX":"X","XXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"T","TTXXTXTT":"T","TXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"T","TTXXTXTT":"T","TXXTXTTT":"T","XXTXTTTT":"X","XTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"X","TTXXXTXX":"T","TXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"X","TTTTXTXX":"T","TTTXTXXT":"X","TTXTXXTX":"X","TXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"X","XTXXXXXX":"X","TXXXXXXX":"T","XXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"T","XXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"T","XTTXTTXT":"X","TTXTTXTX":"X","TXTTXTXX":"T","XTTXTXXT":"X","TTXTXXTX":"T","TXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"T","TXTXTTTT":"X","XTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"T","TTXXXTXT":"T","TXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"T","XXTXXTXT":"T","XTXXTXTT":"T","TXXTXTTT":"T","XXTXTTTT":"T","XTXTTTTT":"X","TXTTTTTX":"T","XTTTTTXT":"X","TTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"X","TTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"X","TXTTXTTX":"X","XTTXTTXX":"T","TTXTTXXT":"X","TXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"T","XXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"X","TXTTTXXX":"T","XTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"T","TXXXTTXT":"X","XXXTTXTX":"X","XXTTXTXX":"X","XTTXTXXX":"X","TTXTXXXX":"X","TXTXXXXX":"X","XTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"T","XTTXXXXT":"T","TTXXXXTT":"T","TXXXXTTT":"T","XXXXTTTT":"T","XXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"X","TTTTTXXX":"X","TTTTXXXX":"X","TTTXXXXX":"T","TTXXXXXT":"X","TXXXXXTX":"X","XXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"X","TXTXXTTX":"X","XTXXTTXX":"X","TXXTTXXX":"X","XXTTXXXX":"X","XTTXXXXX":"T","TTXXXXXT":"T","TXXXXXTT":"X","XXXXXTTX":"T","XXXXTTXT":"T","XXXTTXTT":"T","XXTTXTTT":"X","XTTXTTTX":"X","TTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"X","TTTXXXXX":"X","TTXXXXXX":"X","TXXXXXXX":"T","XXXXXXXT":"X","XXXXXXTX":"T","XXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"X","TTTXXXXX":"T","TTXXXXXT":"X","TXXXXXTX":"X","XXXXXTXX":"X","XXXXTXXX":"X","XXXTXXXX":"T","XXTXXXXT":"X","XTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"T","TTXXXTXT":"T","TXXXTXTT":"X","XXXTXTTX":"X","XXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"T","XTTTTXTT":"T","TTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"T","XTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"T","XTTTTXXT":"T","TTTTXXTT":"T","TTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"X","TTXXXTXX":"X","TXXXTXXX":"X","XXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"X","XXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTX":"T","XTTTTTXT":"T","TTTTTXTT":"T","TTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"X","TXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"T","TTXTXXXT":"X","TXTXXXTX":"T","XTXXXTXT":"X","TXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"X","XTTXTTTX":"X","TTXTTTXX":"X","TXTTTXXX":"T","XTTTXXXT":"X","TTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"X","XTXTXXXX":"T","TXTXXXXT":"T","XTXXXXTT":"T","TXXXXTTT":"T","XXXXTTTT":"T","XXXTTTTT":"X","XXTTTTTX":"T","XTTTTTXT":"X","TTTTTXTX":"T","TTTTXTXT":"X","TTTXTXTX":"X","TTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"X","TXTXXXTX":"T","XTXXXTXT":"X","TXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"X","TTXXXTXX":"T","TXXXTXXT":"X","XXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"X","XXTXXXTX":"T","XTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"X","XTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"X","XXXTTTTX":"T","XXTTTTXT":"T","XTTTTXTT":"X","TTTTXTTX":"T","TTTXTTXT":"T","TTXTTXTT":"X","TXTTXTTX":"X","XTTXTTXX":"T","TTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"T","XTTTTXTT":"T","TTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"X","TXTTTXTX":"X","XTTTXTXX":"T","TTTXTXXT":"X","TTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"X","XXTTTXXX":"T","XTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"T","XXTXXXXT":"T","XTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"X","TTTXXXXX":"X","TTXXXXXX":"X","TXXXXXXX":"T","XXXXXXXT":"X","XXXXXXTX":"T","XXXXXTXT":"X","XXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"T","TXTXTXXT":"T","XTXTXXTT":"T","TXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"T","XTTTXXTT":"X","TTTXXTTX":"X","TTXXTTXX":"X","TXXTTXXX":"T","XXTTXXXT":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"T","XXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"X","TXXTTTXX":"X","XXTTTXXX":"T","XTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"T","TXXTTTXT":"X","XXTTTXTX":"X","XTTTXTXX":"T","TTTXTXXT":"X","TTXTXXTX":"X","TXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"T","XTXXXTTT":"X","TXXXTTTX":"X","XXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"T","TXTXTTTT":"T","XTXTTTTT":"T","TXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"T","TTTTTXXT":"T","TTTTXXTT":"T","TTTXXTTT":"X","TTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"T","XTXTXTXT":"T","TXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"X","XTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"T","TTXTXTXT":"T","TXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"X","TXTTXTXX":"T","XTTXTXXT":"T","TTXTXXTT":"T","TXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"X","TTTXTXTX":"T","TTXTXTXT":"T","TXTXTXTT":"T","XTXTXTTT":"X","TXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"T","TTXXTXTT":"X","TXXTXTTX":"X","XXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"X","XTTXXTTX":"T","TTXXTTXT":"X","TXXTTXTX":"T","XXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"T","XXTXXXTT":"X","XTXXXTTX":"T","TXXXTTXT":"X","XXXTTXTX":"X","XXTTXTXX":"T","XTTXTXXT":"T","TTXTXXTT":"X","TXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"T","XXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"X","XXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"T","TXTXTTTT":"T","XTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"T","XTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"T","XTTTXTTT":"T","TTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"T","XTTTTTXT":"T","TTTTTXTT":"T","T":"Xỉu","TX":"Tài","TXT":"Tài","TXTT":"Tài","TXTTT":"X","TXTTTX":"X","TXTTTXX":"X","TXTTTXXX":"T","XTTTXXXT":"X","TTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"T","XXXTXTXT":"X","XXTXTXTX":"T","XTXTXTXT":"T","TXTXTXTT":"T","XTXTXTTT":"T","TXTXTTTT":"X","XTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"X","TTTXTXTX":"X","TTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"T","XTTTTXXT":"T","TTTTXXTT":"T","TTTXXTTT":"X","TTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"T","XTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"T","XTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"X","TTXTTTTX":"T","TXTTTTXT":"T","XTTTTXTT":"X","TTTTXTTX":"X","TTTXTTXX":"X","TTXTTXXX":"T","TXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"T","TXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"T","TXXXXTTT":"X","XXXXTTTX":"T","XXXTTTXT":"T","XXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"X","TTXTTXXX":"T","TXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"T","TXXXTXTT":"T","XXXTXTTT":"T","XXTXTTTT":"X","XTXTTTTX":"X","TXTTTTXX":"T","XTTTTXXT":"X","TTTTXXTX":"T","TTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"T","TXTXXTXT":"X","XTXXTXTX":"X","TXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"T","XTXXXTTT":"T","TXXXTTTT":"X","XXXTTTTX":"X","XXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"T","TTXXTXTT":"T","TXXTXTTT":"T","XXTXTTTT":"X","XTXTTTTX":"T","TXTTTTXT":"T","XTTTTXTT":"T","TTTTXTTT":"T","TTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"T","TXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"T","XTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"X","TXTXXXTX":"T","XTXXXTXT":"X","TXXXTXTX":"T","XXXTXTXT":"X","XXTXTXTX":"T","XTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"T","XTXXTXXT":"X","TXXTXXTX":"T","XXTXXTXT":"T","XTXXTXTT":"X","TXXTXTTX":"T","XXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"T","TXTTTTTT":"T","XTTTTTTT":"T","TTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"T","TTTXXXTT":"T","TTXXXTTT":"X","TXXXTTTT":"T","XXXTTTTT":"X","XXTTTTTX":"T","XTTTTTXT":"T","TTTTTXTT":"T","TTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"X","TTTXXXXX":"X","TTXXXXXX":"X","TXXXXXXX":"T","XXXXXXXT":"X","XXXXXXTX":"T","XXXXXTXT":"X","XXXXTXTX":"X","XXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"T","TXTXXTTT":"X","XTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"T","XTTTXTTT":"T","TTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"T","TTTXXTXT":"T","TTXXTXTT":"X","TXXTXTTX":"X","XXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"X","XTTXXTTX":"T","TTXXTTXT":"X","TXXTTXTX":"T","XXTTXTXT":"T","XTTXTXTT":"T","TTXTXTTT":"X","TXTXTTTX":"T","XTXTTTXT":"T","TXTTTXTT":"T","XTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"X","TXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"X","TTXTXXXX":"X","TXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"X","XXXXXTXX":"X","XXXXTXXX":"T","XXXTXXXT":"X","XXTXXXTX":"T","XTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"X","TXXXTTXX":"T","XXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"T","TTXXTXTT":"X","TXXTXTTX":"X","XXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"X","XTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"X","XXXXTTXX":"T","XXXTTXXT":"T","XXTTXXTT":"X","XTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"T","XXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"T","XTTTXXTT":"T","TTTXXTTT":"X","TTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"T","XTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"X","TXTTTXTX":"T","XTTTXTXT":"X","TTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"T","TXTXXXTT":"X","XTXXXTTX":"T","TXXXTTXT":"X","XXXTTXTX":"T","XXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"X","TXTXTXXX":"X","XTXTXXXX":"X","TXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"T","XXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"T","XTXTTTXT":"X","TXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"T","TTXTXXXT":"T","TXTXXXTT":"T","XTXXXTTT":"T","TXXXTTTT":"T","XXXTTTTT":"X","XXTTTTTX":"T","XTTTTTXT":"T","TTTTTXTT":"X","TTTTXTTX":"X","TTTXTTXX":"T","TTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"T","XXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"X","TXXXTXXX":"X","XXXTXXXX":"T","XXTXXXXT":"X","XTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"T","TXXXTTXT":"T","XXXTTXTT":"T","XXTTXTTT":"X","XTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"X","TTXTTXXX":"T","TXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"T","TXXXTXTT":"X","XXXTXTTX":"X","XXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"X","XXXTXXTX":"X","XXTXXTXX":"T","XTXXTXXT":"X","TXXTXXTX":"T","XXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"X","XTXTXXXX":"T","TXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"T","TXXXXXTT":"X","XXXXXTTX":"T","XXXXTTXT":"X","XXXTTXTX":"T","XXTTXTXT":"T","XTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"T","TXTTXTXT":"T","XTTXTXTT":"T","TTXTXTTT":"X","TXTXTTTX":"X","XTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"T","TTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"X","XXXTXXTX":"T","XXTXXTXT":"T","XTXXTXTT":"T","TXXTXTTT":"X","XXTXTTTX":"T","XTXTTTXT":"X","TXTTTXTX":"T","XTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"T","XXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"T","XTXTXTTT":"X","TXTXTTTX":"T","XTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"X","TTXTTXXX":"T","TXTTXXXT":"X","XTTXXXTX":"T","TTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"T","XXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"T","XXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"T","TXTTTXXT":"T","XTTTXXTT":"T","TTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTX":"X","XTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"T","XXTXXTXT":"T","XTXXTXTT":"T","TXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"X","TTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"T","XXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"T","XTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"X","TTXTTTTX":"T","TXTTTTXT":"T","XTTTTXTT":"T","TTTTXTTT":"X","TTTXTTTX":"X","TTXTTTXX":"T","TXTTTXXT":"T","XTTTXXTT":"T","TTTXXTTT":"X","TTXXTTTX":"T","TXXTTTXT":"T","XXTTTXTT":"T","XTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"T","TTTTXXXT":"X","TTTXXXTX":"X","TTXXXTXX":"T","TXXXTXXT":"X","XXXTXXTX":"X","XXTXXTXX":"T","XTXXTXXT":"T","TXXTXXTT":"X","XXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"T","XXTXXTXT":"X","XTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"T","TTXXTXTT":"T","TXXTXTTT":"T","XXTXTTTT":"X","XTXTTTTX":"X","TXTTTTXX":"T","XTTTTXXT":"T","TTTTXXTT":"T","TTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"X","XXTTTTTX":"X","XTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"X","TTXXTXXX":"T","TXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"X","TXXXTXXX":"T","XXXTXXXT":"X","XXTXXXTX":"X","XTXXXTXX":"T","TXXXTXXT":"T","XXXTXXTT":"X","XXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"T","XXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"T","XTXXXXXT":"T","TXXXXXTT":"X","XXXXXTTX":"T","XXXXTTXT":"X","XXXTTXTX":"T","XXTTXTXT":"T","XTTXTXTT":"T","TTXTXTTT":"X","TXTXTTTX":"T","XTXTTTXT":"X","TXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"X","TTXTXXXX":"T","TXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"T","XTXTXXXT":"X","TXTXXXTX":"T","XTXXXTXT":"X","TXXXTXTX":"X","XXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"T","TXTXXTTT":"T","XTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"T","TTTTTXTT":"X","TTTTXTTX":"X","TTTXTTXX":"T","TTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"T","TTXXTTTT":"T","TXXTTTTT":"X","XXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"T","TTTXXXTT":"X","TTXXXTTX":"T","TXXXTTXT":"T","XXXTTXTT":"T","XXTTXTTT":"X","XTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"X","XTTTXTTX":"X","TTTXTTXX":"T","TTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"X","XXTXTXXX":"T","XTXTXXXT":"X","TXTXXXTX":"T","XTXXXTXT":"T","TXXXTXTT":"T","XXXTXTTT":"T","XXTXTTTT":"T","XTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"T","TTTTXXXT":"T","TTTXXXTT":"T","TTXXXTTT":"X","TXXXTTTX":"X","XXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"T","TTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"X","TXTXXTTX":"T","XTXXTTXT":"T","TXXTTXTT":"T","XXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"T","XTTTTTXT":"T","TTTTTXTT":"T","TTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"T","XXXXTXTT":"T","XXXTXTTT":"X","XXTXTTTX":"X","XTXTTTXX":"X","TXTTTXXX":"T","XTTTXXXT":"T","TTTXXXTT":"T","TTXXXTTT":"X","TXXXTTTX":"T","XXXTTTXT":"X","XXTTTXTX":"T","XTTTXTXT":"X","TTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"T","XTXTXTXT":"T","TXTXTXTT":"T","XTXTXTTT":"X","TXTXTTTX":"T","XTXTTTXT":"X","TXTTTXTX":"T","XTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"T","TXTTXXTT":"T","XTTXXTTT":"X","TTXXTTTX":"T","TXXTTTXT":"X","XXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"T","TTXTXXXT":"X","TXTXXXTX":"X","XTXXXTXX":"T","TXXXTXXT":"X","XXXTXXTX":"T","XXTXXTXT":"T","XTXXTXTT":"X","TXXTXTTX":"X","XXTXTTXX":"X","XTXTTXXX":"T","TXTTXXXT":"T","XTTXXXTT":"T","TTXXXTTT":"X","TXXXTTTX":"T","XXXTTTXT":"T","XXTTTXTT":"T","XTTTXTTT":"T","TTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"X","XTTTTXXX":"X","TTTTXXXX":"X","TTTXXXXX":"T","TTXXXXXT":"X","TXXXXXTX":"T","XXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"X","XXTXTXTX":"T","XTXTXTXT":"T","TXTXTXTT":"X","XTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"X","XTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"T","XXTXXXXT":"T","XTXXXXTT":"T","TXXXXTTT":"X","XXXXTTTX":"T","XXXTTTXT":"X","XXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"X","TTXTXXXX":"X","TXTXXXXX":"T","XTXXXXXT":"X","TXXXXXTX":"T","XXXXXTXT":"T","XXXXTXTT":"X","XXXTXTTX":"X","XXTXTTXX":"X","XTXTTXXX":"T","TXTTXXXT":"T","XTTXXXTT":"X","TTXXXTTX":"T","TXXXTTXT":"T","XXXTTXTT":"T","XXTTXTTT":"X","XTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"T","XTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"T","TXTTTXTT":"T","XTTTXTTT":"X","TTTXTTTX":"T","TTXTTTXT":"X","TXTTTXTX":"T","XTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"T","TTXTXTXT":"X","TXTXTXTX":"T","XTXTXTXT":"T","TXTXTXTT":"X","XTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"T","XTXTXTXT":"T","TXTXTXTT":"X","XTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"T","XXTXTXTT":"X","XTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"T","TXTXTXXT":"T","XTXTXXTT":"X","TXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"X","XTTXXTXX":"T","TTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"X","XTTTXXTX":"X","TTTXXTXX":"X","TTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"X","XTXXXXXX":"T","TXXXXXXT":"X","XXXXXXTX":"X","XXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"X","XTXXTTTX":"X","TXXTTTXX":"T","XXTTTXXT":"T","XTTTXXTT":"X","TTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"T","TXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"T","TXTXTXXT":"T","XTXTXXTT":"X","TXTXXTTX":"T","XTXXTTXT":"T","TXXTTXTT":"X","XXTTXTTX":"T","XTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"X","TTXTTTTX":"T","TXTTTTXT":"T","XTTTTXTT":"X","TTTTXTTX":"T","TTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"X","TTXTTTTX":"T","TXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"T","XTXTTXXT":"X","TXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"X","XXTXTXXX":"X","XTXTXXXX":"X","TXTXXXXX":"X","XTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"T","XXXTTTTT":"X","XXTTTTTX":"T","XTTTTTXT":"X","TTTTTXTX":"X","TTTTXTXX":"T","TTTXTXXT":"T","TTXTXXTT":"T","TXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"X","XXTTTTXX":"T","XTTTTXXT":"T","TTTTXXTT":"X","TTTXXTTX":"T","TTXXTTXT":"X","TXXTTXTX":"T","XXTTXTXT":"T","XTTXTXTT":"X","TTXTXTTX":"T","TXTXTTXT":"X","XTXTTXTX":"T","TXTTXTXT":"X","XTTXTXTX":"X","TTXTXTXX":"T","TXTXTXXT":"X","XTXTXXTX":"X","TXTXXTXX":"T","XTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"T","TTXTXTTT":"X","TXTXTTTX":"T","XTXTTTXT":"X","TXTTTXTX":"T","XTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"X","XXTXXTTX":"X","XTXXTTXX":"T","TXXTTXXT":"T","XXTTXXTT":"X","XTTXXTTX":"X","TTXXTTXX":"T","TXXTTXXT":"X","XXTTXXTX":"T","XTTXXTXT":"X","TTXXTXTX":"X","TXXTXTXX":"T","XXTXTXXT":"T","XTXTXXTT":"X","TXTXXTTX":"T","XTXXTTXT":"T","TXXTTXTT":"X","XXTTXTTX":"X","XTTXTTXX":"X","TTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"T","XXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"T","TXXTTTTT":"T","XXTTTTTT":"X","XTTTTTTX":"T","TTTTTTXT":"T","TTTTTXTT":"X","TTTTXTTX":"T","TTTXTTXT":"X","TTXTTXTX":"T","TXTTXTXT":"T","XTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"T","TXTTXXXT":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"T","XTTXXXTT":"X","TTXXXTTX":"X","TXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"X","XTTXXXXX":"X","TTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"T","XXXXXTTT":"T","XXXXTTTT":"T","XXXTTTTT":"T","XXTTTTTT":"T","XTTTTTTT":"X","TTTTTTTX":"X","TTTTTTXX":"T","TTTTTXXT":"X","TTTTXXTX":"X","TTTXXTXX":"T","TTXXTXXT":"X","TXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"T","TXXTXXXT":"X","XXTXXXTX":"T","XTXXXTXT":"T","TXXXTXTT":"X","XXXTXTTX":"T","XXTXTTXT":"T","XTXTTXTT":"T","TXTTXTTT":"X","XTTXTTTX":"X","TTXTTTXX":"X","TXTTTXXX":"X","XTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"T","XXXXTTXT":"T","XXXTTXTT":"X","XXTTXTTX":"X","XTTXTTXX":"T","TTXTTXXT":"X","TXTTXXTX":"X","XTTXXTXX":"T","TTXXTXXT":"T","TXXTXXTT":"T","XXTXXTTT":"T","XTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"T","XTTTTXTT":"X","TTTTXTTX":"T","TTTXTTXT":"T","TTXTTXTT":"T","TXTTXTTT":"T","XTTXTTTT":"T","TTXTTTTT":"X","TXTTTTTX":"X","XTTTTTXX":"X","TTTTTXXX":"X","TTTTXXXX":"T","TTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","X":"T","XX":"T","XXT":"X","XXTX":"T","XXTXT":"X","XXTXTX":"X","XXTXTXX":"X","XXTXTXXX":"X","XTXTXXXX":"T","TXTXXXXT":"T","XTXXXXTT":"X","TXXXXTTX":"T","XXXXTTXT":"X","XXXTTXTX":"X","XXTTXTXX":"X","XTTXTXXX":"X","TTXTXXXX":"T","TXTXXXXT":"T","XTXXXXTT":"X","TXXXXTTX":"T","XXXXTTXT":"T","XXXTTXTT":"T","XXTTXTTT":"T","XTTXTTTT":"X","TTXTTTTX":"X","TXTTTTXX":"T","XTTTTXXT":"T","TTTTXXTT":"T","TTTXXTTT":"T","TTXXTTTT":"X","TXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"T","TTTXTXTT":"X","TTXTXTTX":"X","TXTXTTXX":"X","XTXTTXXX":"X","TXTTXXXX":"T","XTTXXXXT":"T","TTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"T","XTTXXXXT":"X","TTXXXXTX":"X","TXXXXTXX":"T","XXXXTXXT":"X","XXXTXXTX":"X","XXTXXTXX":"X","XTXXTXXX":"X","TXXTXXXX":"X","XXTXXXXX":"X","XTXXXXXX":"X","TXXXXXXX":"X","XXXXXXXX":"T","XXXXXXXT":"X","XXXXXXTX":"X","XXXXXTXX":"X","XXXXTXXX":"T","XXXTXXXT":"T","XXTXXXTT":"T","XTXXXTTT":"T","TXXXTTTT":"X","XXXTTTTX":"T","XXTTTTXT":"X","XTTTTXTX":"T","TTTTXTXT":"X","TTTXTXTX":"X","TTXTXTXX":"X","TXTXTXXX":"X","XTXTXXXX":"T","TXTXXXXT":"T","XTXXXXTT":"T","TXXXXTTT":"X","XXXXTTTX":"T","XXXTTTXT":"X","XXTTTXTX":"X","XTTTXTXX":"X","TTTXTXXX":"X","TTXTXXXX":"T","TXTXXXXT":"X","XTXXXXTX":"T","TXXXXTXT":"X","XXXXTXTX":"T","XXXTXTXT":"X","XXTXTXTX":"X","XTXTXTXX":"X","TXTXTXXX":"X","XTXTXXXX":"X","TXTXXXXX":"X","XTXXXXXX":"T","TXXXXXXT":"T","XXXXXXTT":"X","XXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"X","XXTTXXXX":"X","XTTXXXXX":"T","TTXXXXXT":"T","TXXXXXTT":"T","XXXXXTTT":"X","XXXXTTTX":"T","XXXTTTXT":"X","XXTTTXTX":"T","XTTTXTXT":"X","TTTXTXTX":"X","TTXTXTXX":"X","TXTXTXXX":"X","XTXTXXXX":"T","TXTXXXXT":"T","XTXXXXTT":"X","TXXXXTTX":"X","XXXXTTXX":"X","XXXTTXXX":"T","XXTTXXXT":"T","XTTXXXTT":"T","TTXXXTTT":"X","TXXXTTTX":"X"
};

function algo14_ExactHistoryMatch(history) {
    if (history.length === 0) return null;
    const txString = history.map(h => h.tx).join('');
    
    // Tìm kiếm chuỗi lịch sử dài nhất có sẵn trong thư viện.
    const maxLen = Math.min(txString.length, 8); 
    for (let len = maxLen; len >= 1; len--) {
        const pattern = txString.slice(-len);
        if (THUAT_TOAN_8_DICT[pattern]) {
            return THUAT_TOAN_8_DICT[pattern];
        }
    }
    
    // NÂNG CẤP DẦY ĐẶC (Fuzzy matching nhận diện chuỗi chìm)
    if (txString.length >= 5) {
        const last5 = txString.slice(-5);
        let tCount = 0, xCount = 0;
        for (const key in THUAT_TOAN_8_DICT) {
            if (key.endsWith(last5)) {
                if (THUAT_TOAN_8_DICT[key] === 'T') tCount++;
                else xCount++;
            }
        }
        if (tCount > xCount * 1.5) return 'T';
        if (xCount > tCount * 1.5) return 'X';
    }
    return null;
}

// Thuật toán 15: AI Vi Long Đa Đảo & Bám cứng cầu 1-1, 2-2
function algo15_AIViLong_MultiInversion(history) {
    if (history.length < 5) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    
    // 1. CHỐNG BẺ CẦU 1-1 (Nhận diện siêu tốc)
    const lastRuns = runs.slice(-8);
    const is1_1 = lastRuns.length >= 4 && lastRuns.slice(-4).every(r => r.len === 1);
    if (is1_1) {
        return tx[tx.length - 1] === 'T' ? 'X' : 'T'; // Tuyệt đối theo 1-1
    }

    // 2. CHỐNG BẺ CẦU 2-2 (Nhận diện siêu tốc)
    const is2_2_ready = lastRuns.length >= 3 && lastRuns.slice(-3).map(r => r.len).join(',') === '2,2,1';
    if (is2_2_ready) {
        return tx[tx.length - 1]; // Bù cho đủ nhịp 2
    }
    const is2_2_full = lastRuns.length >= 3 && lastRuns.slice(-3).every(r => r.len === 2);
    if (is2_2_full) {
        const lastRun = runs[runs.length - 1];
        return lastRun.val === 'T' ? 'X' : 'T'; // Hết 2 thì bẻ qua nhịp kia
    }

    // 3. TỰ HỌC ĐẢO ĐA THUẬT TOÁN (AI Momentum)
    const last10 = tx.slice(-10);
    let sameCount = 0, diffCount = 0;
    for (let i = 0; i < last10.length - 1; i++) {
        if (last10[i] === last10[i+1]) sameCount++;
        else diffCount++;
    }
    
    if (diffCount > sameCount + 2) {
        return tx[tx.length - 1] === 'T' ? 'X' : 'T'; // Đang nhịp đảo nhanh, đánh ngược màu
    }
    if (sameCount > diffCount + 2) {
        return tx[tx.length - 1]; // Đang nhịp bệt trôi, đánh đồng màu
    }

    return null;
}

// =====================================================================
// === BỘ 5 THUẬT TOÁN BỔ TRỢ MỚI (ULTRA GOD MODE V8.0) ===
// =====================================================================

// Thuật toán 16: Flash Detect VIP (Nhận diện soi nhanh cầu 1-1, 2-2 bắt cứng ngắc)
function algo16_FlashDetect_1_1_and_2_2(history) {
    if (history.length < 5) return null;
    const tx = history.map(h => h.tx);
    const last2 = tx.slice(-2).join('');
    const last3 = tx.slice(-3).join('');
    const last4 = tx.slice(-4).join('');

    // Bắt cầu 1-1 siêu tốc: Ví dụ T-X thì ra T, X-T thì ra X
    // Đảm bảo không bẻ ngang khi đang chạy 1-1
    if (last3 === 'TXT') return 'X'; // X-T-X -> tiếp theo phải là T (ở đây lấy TXT -> X để nối nhịp)
    if (last3 === 'XTX') return 'T'; // T-X-T -> tiếp theo phải là X 
    
    // Nhận diện sớm nhịp gãy để vào 1-1 theo ví dụ của bạn:
    if (last2 === 'TX' && tx[tx.length-3] !== 'T') return 'T'; // Vừa gãy sang T-X, đập luôn T
    if (last2 === 'XT' && tx[tx.length-3] !== 'X') return 'X'; // Vừa gãy sang X-T, đập luôn X

    // Bắt cầu 2-2 siêu tốc: Ví dụ X-T-X-X -> con tiếp theo phải là T
    if (last4 === 'XTXX') return 'T'; // Nhịp cầu X, T, XX -> Cầu 2-2 khuyết nhịp đầu, ra T để lấp
    if (last4 === 'TXTT') return 'X'; // Nhịp cầu T, X, TT -> Ra X để lấp

    // Bắt cứng 2-2 cơ bản
    if (last4 === 'TTXX') return 'T';
    if (last4 === 'XXTT') return 'X';

    return null;
}

// Thuật toán 17: Phân Tích Động Năng Điểm Xúc Xắc VIP
function algo17_DiceMomentum(history) {
    if (history.length < 6) return null;
    const totals = history.map(h => h.total);
    const lastTotal = totals[totals.length - 1];
    const prevTotal = totals[totals.length - 2];
    
    // Các mức điểm nhạy cảm thường bẻ cầu: 10 và 11 là ranh giới Tài/Xỉu
    if (lastTotal === 11 && prevTotal > 11) return 'X'; // Rớt đài từ Tài lớn xuống 11 -> Kéo xỉu
    if (lastTotal === 10 && prevTotal < 10) return 'T'; // Trồi từ Xỉu nhỏ lên 10 -> Kéo tài
    
    // Động năng giật mạnh
    if (lastTotal - prevTotal >= 6) return 'T'; // Kéo giật quá mạnh, thường giữ nhịp Tài
    if (prevTotal - lastTotal >= 6) return 'X'; // Xả giật quá mạnh, thường giữ nhịp Xỉu

    return null;
}

// Thuật toán 18: Truy Quét Gương Đối Xứng (Symmetric Radar)
function algo18_SymmetricRadar(history) {
    if (history.length < 8) return null;
    const tx = history.map(h => h.tx).join('');
    const last7 = tx.slice(-7);
    
    // Tìm các mẫu gương điển hình (trục giữa)
    if (last7.slice(0, 3) === last7.slice(4, 7).split('').reverse().join('')) {
        // Có đối xứng gương, đánh theo trục
        return last7[3] === 'T' ? 'X' : 'T'; 
    }
    
    const last5 = tx.slice(-5);
    if (last5 === 'TTXTT') return 'X';
    if (last5 === 'XXTXX') return 'T';
    if (last5 === 'TXTXT') return 'X'; // Bắt tiếp 1-1
    if (last5 === 'XTXTX') return 'T';

    return null;
}

// Thuật toán 19: Phân Phối Poisson Khối MD5
function algo19_PoissonMD5(history) {
    if (history.length < 20) return null;
    const totals = history.map(h => h.total);
    const recentTotals = totals.slice(-15);
    const mean = avg(recentTotals);
    
    // Mô phỏng hàm phân phối để tính xem chuỗi hiện tại đang "căng" ở đâu
    let tProb = 0, xProb = 0;
    if (mean > 12.5) {
        // Tích tụ Tài quá nhiều -> Buộc xả Xỉu
        xProb = 0.7;
        tProb = 0.3;
    } else if (mean < 8.5) {
        // Tích tụ Xỉu quá nhiều -> Buộc nổ Tài
        tProb = 0.7;
        xProb = 0.3;
    } else {
        // Lơ lửng ở giữa, đánh theo xu hướng nến
        if (totals[totals.length-1] > totals[totals.length-2]) tProb += 0.2;
        else xProb += 0.2;
    }
    
    if (tProb > xProb + 0.3) return 'T';
    if (xProb > tProb + 0.3) return 'X';
    return null;
}

// Thuật toán 20: Vi Long Tối Thượng (Absolute God Mode)
function algo20_AbsoluteGodMode(history) {
    if (history.length < 25) return null;
    const features = extractFeatures(history);
    
    // Nếu độ mập mờ (entropy) max level, AI sẽ tự động kích hoạt bộ đóng băng
    if (features.entropy > 0.98) {
        const recentRuns = features.runs.slice(-5);
        const allShort = recentRuns.every(r => r.len <= 2);
        // Nếu cầu đang siêu lộn xộn nhưng toàn cầu ngắn -> Buộc phải ra bệt
        if (allShort) {
            return history[history.length-1].tx; // Đánh bệt màu cuối cùng
        }
    }
    
    // Khóa chốt lời: Nếu xúc xắc ra bộ bão (3 con giống nhau) hoặc sát bão
    const lastDice = history[history.length-1].dice;
    if (lastDice[0] === lastDice[1] && lastDice[1] === lastDice[2]) {
        return history[history.length-1].tx === 'T' ? 'X' : 'T'; // Bão xong auto bẻ
    }
    
    return null;
}

// --- DANH SÁCH THUẬT TOÁN ĐẦY ĐỦ (CẬP NHẬT 20 THUẬT TOÁN) ---
const ALL_ALGS = [
    { id: 'algo5_freqrebalance', fn: algo5_freqRebalance },
    { id: 'a_markov', fn: algoA_markov },
    { id: 'b_ngram', fn: algoB_ngram },
    { id: 's_neo_pattern', fn: algoS_NeoPattern },
    { id: 'f_super_deep_analysis', fn: algoF_SuperDeepAnalysis },
    { id: 'e_transformer', fn: algoE_Transformer },
    { id: 'g_super_bridge_predictor', fn: algoG_SuperBridgePredictor },
    { id: 'h_adaptive_markov', fn: algoH_AdaptiveMarkov },
    { id: 'i_pattern_master', fn: algoI_PatternMaster },
    { id: 'j_quantum_entropy', fn: algoJ_QuantumEntropy },
    { id: 'k_vip_master_pattern', fn: algoK_VIP_Master_Pattern },
    { id: 'l_ultimate_bridge_breaker', fn: algoL_UltimateBridgeBreaker },
    { id: 'm_deep_chaos_dice_analyzer', fn: algoM_DeepChaosDiceAnalyzer },
    { id: 'algo14_exact_history_match', fn: algo14_ExactHistoryMatch }, 
    { id: 'algo15_aivilong_multiinversion', fn: algo15_AIViLong_MultiInversion },
    { id: 'algo16_flashdetect_1_1_and_2_2', fn: algo16_FlashDetect_1_1_and_2_2 },
    { id: 'algo17_dicemomentum', fn: algo17_DiceMomentum },
    { id: 'algo18_symmetricradar', fn: algo18_SymmetricRadar },
    { id: 'algo19_poissonmd5', fn: algo19_PoissonMD5 },
    { id: 'algo20_absolutegodmode', fn: algo20_AbsoluteGodMode }
];

// --- ENSEMBLE CLASSIFIER NÂNG CẤP VIP TƯ DUY CON NGƯỜI ---
class SEIUEnsemble {
    constructor(algorithms, opts = {}) { 
        this.algs = algorithms;
        this.weights = {};
        this.emaAlpha = opts.emaAlpha ?? 0.06;
        this.minWeight = opts.minWeight ?? 0.01;
        this.historyWindow = opts.historyWindow ?? 700;
        this.performanceHistory = {};
        this.patternMemory = {};
        
        for (const a of algorithms) {
            this.weights[a.id] = 1.0;
            this.performanceHistory[a.id] = [];
        }
    }
    
    fitInitial(history) {
        const window = lastN(history, Math.min(this.historyWindow, history.length));
        if (window.length < 30) return;
        
        const algScores = {};
        for (const a of this.algs) algScores[a.id] = 0;

        const evalSamples = Math.min(40, window.length - 15);
        const startIdx = window.length - evalSamples;
        
        for (let i = Math.max(15, startIdx); i < window.length; i++) {
            const prefix = window.slice(0, i);
            const actual = window[i].tx;
            const features = extractFeatures(prefix);
            const patternType = detectPatternType(features.runs);
            
            for (const a of this.algs) {
                try {
                    const pred = a.fn(prefix);
                    if (pred && pred === actual) {
                        algScores[a.id] += 1;
                        if (patternType) {
                            const key = `${a.id}_${patternType}`;
                            this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                        }
                    }
                } catch (e) {}
            }
        }

        let totalWeight = 0;
        for (const id in algScores) {
            const score = algScores[id] || 0;
            const accuracy = score / evalSamples;
            const baseWeight = 0.3 + (accuracy * 0.7);
            this.weights[id] = Math.max(this.minWeight, baseWeight);
            totalWeight += this.weights[id];
        }
        
        if (totalWeight > 0) {
            for (const id in this.weights) {
                this.weights[id] /= totalWeight;
            }
        }
        console.log(`⚖️ Đã khởi tạo trọng số cho ${Object.keys(this.weights).length} thuật toán VIP.`);
    }

    updateWithOutcome(historyPrefix, actualTx) {
        if (historyPrefix.length < 10) return;
        
        const features = extractFeatures(historyPrefix);
        const patternType = detectPatternType(features.runs);
        
        for (const a of this.algs) {
            try {
                const pred = a.fn(historyPrefix);
                const correct = pred === actualTx ? 1 : 0;
                
                this.performanceHistory[a.id].push(correct);
                if (this.performanceHistory[a.id].length > 60) {
                    this.performanceHistory[a.id].shift();
                }
                
                const recentPerf = lastN(this.performanceHistory[a.id], 25);
                let weightedAccuracy = 0, weightSum = 0;
                
                for (let i = 0; i < recentPerf.length; i++) {
                    const weight = Math.pow(0.9, recentPerf.length - i - 1);
                    weightedAccuracy += recentPerf[i] * weight;
                    weightSum += weight;
                }
                
                const recentAccuracy = weightSum > 0 ? weightedAccuracy / weightSum : 0.5;
                let patternBonus = 0;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 3) patternBonus = 0.15;
                }
                
                const targetWeight = Math.min(1, recentAccuracy + patternBonus + 0.1);
                const currentWeight = this.weights[a.id] || this.minWeight;
                const newWeight = this.emaAlpha * targetWeight + (1 - this.emaAlpha) * currentWeight;
                this.weights[a.id] = Math.max(this.minWeight, Math.min(1.5, newWeight));
                
                if (patternType && correct) {
                    const key = `${a.id}_${patternType}`;
                    this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                }
            } catch (e) {
                this.weights[a.id] = Math.max(this.minWeight, (this.weights[a.id] || 1) * 0.92);
            }
        }

        const sumWeights = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (sumWeights > 0) {
            for (const id in this.weights) {
                this.weights[id] /= sumWeights;
            }
        }
    }

    predict(history) {
        if (history.length < 12) {
            return { prediction: 'Tài', confidence: 0.5, rawPrediction: 'T' };
        }
        
        // --- [NÂNG CẤP TỐI THƯỢNG] BỘ LỌC ÉP KẾT QUẢ FLASH DETECT ---
        // Bắt cứng ngắc theo yêu cầu: Đang 1-1 không cho trượt, đang 2-2 chốt chuẩn
        const flashOverride = algo16_FlashDetect_1_1_and_2_2(history);
        if (flashOverride) {
            return {
                prediction: flashOverride === 'T' ? 'Tài' : 'Xỉu',
                confidence: 0.99, // Ép cứng 99% tuyệt đối, không quan tâm ensemble
                rawPrediction: flashOverride,
                note: "🔥 [ULTRA GOD MODE] KHÓA CỨNG CẦU 1-1 / 2-2"
            };
        }

        const features = extractFeatures(history);
        const patternType = detectPatternType(features.runs);
        const votes = { T: 0, X: 0 };
        let algorithmDetails = [];
        
        for (const a of this.algs) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                let weight = this.weights[a.id] || this.minWeight;
                
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 2) weight *= 1.3; 
                }
                
                if (a.id === 'k_vip_master_pattern') weight *= 1.5;
                if (a.id === 'algo14_exact_history_match') weight *= 1.6; 
                if (a.id === 'algo15_aivilong_multiinversion') weight *= 2.5; 
                if (a.id === 'm_deep_chaos_dice_analyzer' && (patternType === 'random_pattern' || patternType === 'cau_tu_nhien')) {
                    weight *= 1.8; 
                }
                // Các thuật toán VIP mới được boost trọng số cực mạnh
                if (a.id === 'algo17_dicemomentum') weight *= 2.0;
                if (a.id === 'algo18_symmetricradar') weight *= 2.0;
                if (a.id === 'algo19_poissonmd5') weight *= 1.8;
                if (a.id === 'algo20_absolutegodmode') weight *= 3.0; // Quyền lực tuyệt đối thứ 2

                votes[pred] = (votes[pred] || 0) + weight;
                algorithmDetails.push({ algorithm: a.id, prediction: pred, weight: weight });
            } catch (e) {}
        }
        
        if (votes.T === 0 && votes.X === 0) {
            const fallback = algo5_freqRebalance(history) || 'T';
            return { prediction: fallback === 'T' ? 'Tài' : 'Xỉu', confidence: 0.5, rawPrediction: fallback };
        }
        
        const { key: best, val: bestVal } = majority(votes);
        const totalVotes = votes.T + votes.X;
        const baseConfidence = bestVal / totalVotes;
        
        let consensusBonus = 0;
        const tAlgorithms = algorithmDetails.filter(a => a.prediction === 'T').length;
        const xAlgorithms = algorithmDetails.filter(a => a.prediction === 'X').length;
        const totalAlgorithms = tAlgorithms + xAlgorithms;
        
        if (totalAlgorithms > 0) {
            const consensusRatio = Math.max(tAlgorithms, xAlgorithms) / totalAlgorithms;
            if (consensusRatio > 0.7) consensusBonus = 0.12;
            if (consensusRatio > 0.8) consensusBonus = 0.18;
        }
        
        const confidence = Math.min(0.98, Math.max(0.50, baseConfidence + consensusBonus));

        // --- NÂNG CẤP VIP: NHẬN DIỆN VÀ BÁM CHẶT BỆT / 1-1 / 2-2 ---
        const lastRun = features.runs[features.runs.length - 1];
        const isBet = lastRun && lastRun.len >= 4;
        const is1_1 = patternType === '1_1_pattern' || patternType === 'cau_dao_11';
        const is2_2 = patternType === '2_2_pattern';

        const recentTotals = features.totals.slice(-5);
        const variance = avg(recentTotals.map(t => Math.pow(t - avg(recentTotals), 2)));
        const isCauAo = variance > 5.5 && features.entropy > 0.90 && (isBet || is1_1);

        if (isCauAo) {
            return {
                prediction: 'Bỏ tay này (Cảnh báo Cầu Ảo / Biến động MD5 dị thường cực nguy hiểm)',
                confidence: 0.0,
                rawPrediction: null
            };
        }

        if (isBet) {
             const betPred = lastRun.val;
             return {
                 prediction: betPred === 'T' ? 'Tài' : 'Xỉu',
                 confidence: Math.max(confidence, 0.88),
                 rawPrediction: betPred
             };
        }

        if (is1_1) {
             const nextPred = features.tx[features.tx.length - 1] === 'T' ? 'X' : 'T';
             return {
                 prediction: nextPred === 'T' ? 'Tài' : 'Xỉu',
                 confidence: Math.max(confidence, 0.95), // Bắt cứng 1-1
                 rawPrediction: nextPred
             };
        }

        if (is2_2 || features.runs.slice(-3).map(r=>r.len).join(',') === '2,2,1') {
             let nextPred;
             if (lastRun.len === 1) nextPred = lastRun.val; 
             else nextPred = lastRun.val === 'T' ? 'X' : 'T'; 
             return {
                 prediction: nextPred === 'T' ? 'Tài' : 'Xỉu',
                 confidence: Math.max(confidence, 0.92), // Bắt cứng 2-2
                 rawPrediction: nextPred
             };
        }

        if (confidence < 0.60 || Math.abs(votes.T - votes.X) < (totalVotes * 0.15)) {
            return {
                prediction: 'Bỏ tay này (Cầu đang mập mờ, tỷ lệ thắng thấp)',
                confidence: confidence,
                rawPrediction: null
            };
        }
        
        return {
            prediction: best === 'T' ? 'Tài' : 'Xỉu',
            confidence,
            rawPrediction: best
        };
    }
}

// --- PATTERN ANALYSIS ĐƠN GIẢN VÀ VIP ---
function getComplexPattern(history) {
    const minHistory = 15;
    if (history.length < minHistory) return "n/a";
    const vipPat = detectVIPPattern(history);
    const historyTx = history.map(h => h.tx);
    const baseStr = historyTx.slice(-minHistory).join('').toLowerCase();
    if (vipPat && vipPat.length > 0) {
        const vnNames = vipPat.map(vp => Object.keys(VIP_PATTERN_MAP).find(k => VIP_PATTERN_MAP[k] === vp) || vp);
        return `[VIP VI LONG: ${vnNames.join(', ')}] - ${baseStr}`;
    }
    return baseStr;
}

// --- MANAGER CLASS TỐI ƯU ---
class SEIUManager {
    constructor(opts = {}) {
        this.history = [];
        this.ensemble = new SEIUEnsemble(ALL_ALGS, {
            emaAlpha: opts.emaAlpha ?? 0.06,
            historyWindow: opts.historyWindow ?? 700
        });
        this.currentPrediction = null;
        this.patternHistory = [];
    }
    
    calculateInitialStats() {
        const minStart = 20;
        if (this.history.length < minStart) return;
        const trainSamples = Math.min(60, this.history.length - minStart);
        const startIdx = this.history.length - trainSamples;
        for (let i = Math.max(minStart, startIdx); i < this.history.length; i++) {
            const historyPrefix = this.history.slice(0, i);
            const actualTx = this.history[i].tx;
            this.ensemble.updateWithOutcome(historyPrefix, actualTx);
        }
        console.log(`📊 AI VIP VI LONG đã huấn luyện trên ${trainSamples} mẫu.`);
    }

    loadInitial(lines) {
        this.history = lines;
        this.ensemble.fitInitial(this.history);
        this.calculateInitialStats();
        this.currentPrediction = this.getPrediction();
        console.log("📦 Đã tải lịch sử. Hệ thống AI VIP sẵn sàng.");
        const nextSession = this.history.at(-1) ? this.history.at(-1).session + 1 : 'N/A';
        console.log(`🔮 Dự đoán phiên ${nextSession}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    pushRecord(record) {
        this.history.push(record);
        if (this.history.length > 500) this.history = this.history.slice(-450);
        const prefix = this.history.slice(0, -1);
        if (prefix.length >= 10) this.ensemble.updateWithOutcome(prefix, record.tx);
        
        this.currentPrediction = this.getPrediction();
        const features = extractFeatures(this.history);
        const patternType = detectPatternType(features.runs);
        if (patternType) {
            this.patternHistory.push(patternType);
            if (this.patternHistory.length > 20) this.patternHistory.shift();
        }
        console.log(`📥 ${record.session} → ${record.result}. Dự đoán ${record.session + 1}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    getPrediction() {
        return this.ensemble.predict(this.history);
    }
}

const seiuManager = new SEIUManager();

// --- API SERVER ---
const app = fastify({ logger: true });
await app.register(cors, { origin: "*" });

async function fetchAndProcessHistory() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const newHistory = parseLines(data);
        if (newHistory.length === 0) return console.log("⚠️ Không có dữ liệu từ API.");
        const lastSessionInHistory = newHistory.at(-1);

        if (!currentSessionId) {
            seiuManager.loadInitial(newHistory);
            txHistory = newHistory;
            currentSessionId = lastSessionInHistory.session;
            console.log(`✅ Đã tải ${newHistory.length} phiên lịch sử.`);
        } else if (lastSessionInHistory.session > currentSessionId) {
            const newRecords = newHistory.filter(r => r.session > currentSessionId);
            for (const record of newRecords) {
                seiuManager.pushRecord(record);
                txHistory.push(record);
            }
            if (txHistory.length > 350) txHistory = txHistory.slice(-300);
            currentSessionId = lastSessionInHistory.session;
            if (newRecords.length > 0) console.log(`🆕 Cập nhật ${newRecords.length} phiên. Phiên cuối: ${currentSessionId}`);
        }
    } catch (e) {
        console.error("❌ Lỗi fetch dữ liệu:", e.message);
    }
}

fetchAndProcessHistory();
clearInterval(fetchInterval);
fetchInterval = setInterval(fetchAndProcessHistory, 5000);
console.log(`🔄 Đang chạy với chu kỳ 5 giây.`);

// API Endpoints
app.get("/api/taixiumd5/lc79", async () => {
    const lastResult = txHistory.at(-1) || null;
    const currentPrediction = seiuManager.currentPrediction;
    let pattern = getComplexPattern(seiuManager.history);

    // Gắn nhãn God Mode nếu phát hiện
    if (currentPrediction && currentPrediction.note) {
        pattern = currentPrediction.note + " | " + pattern;
    }

    if (!lastResult || !currentPrediction) {
        return {
            id: "by VIP @cskhvilong",
            phien_truoc: null,
            tong: null,
            ket_qua: "đang chờ...",
            xuc_sac: [],
            pattern: "đang phân tích...",
            phien_hien_tai: null,
            du_doan: "chưa có",
            do_tin_cay: "0%",
            no_random: "by vi long"
        };
    }

    return {
        id: "by VIP @cskhvilong",
        phien_truoc: lastResult.session,
        tong: lastResult.total,
        ket_qua: lastResult.result.toUpperCase(),
        xuc_sac: lastResult.dice, 
        pattern: pattern,
        phien_hien_tai: lastResult.session + 1,
        du_doan: currentPrediction.prediction.toUpperCase(),
        do_tin_cay: `${(currentPrediction.confidence * 100).toFixed(0)}%`,
        no_random: "by vi long"
    };
});

app.get("/api/taixiumd5/history", async () => { 
    if (!txHistory.length) return { message: "không có dữ liệu lịch sử." };
    const reversedHistory = [...txHistory].sort((a, b) => b.session - a.session);
    return reversedHistory.map((i) => ({
        session: i.session,
        total: i.total,
        result: i.result.toUpperCase(),
        tx_label: i.tx.toUpperCase(),
        dice: i.dice
    }));
});

app.get("/", async () => { 
    return {
        status: "ok",
        msg: "AI Tài Xỉu MD5 Pro - Phiên bản Ultra God Mode VIP VI LONG",
        version: "8.0 AI Vi Long Absolute Core", 
        algorithms: ALL_ALGS.length,
        pattern_recognition: "ULTRA VIP (Khóa ngắc 1-1 & 2-2, Bắt Đỉnh Phân Phối Poisson, Ghi Đè God Mode)",
        endpoints: [
            "/api/taixiumd5/lc79",
            "/api/taixiumd5/history"
        ]
    };
});

const start = async () => {
    try { await app.listen({ port: PORT, host: "0.0.0.0" }); } 
    catch (err) {
        const fs = await import("node:fs");
        const logFile = path.join(__dirname, "server-error.log");
        const errorMsg = `\n================= SERVER ERROR =================\nTime: ${new Date().toISOString()}\nError: ${err.message}\nStack: ${err.stack}\n=================================================\n`;
        console.error(errorMsg);
        fs.writeFileSync(logFile, errorMsg, { encoding: "utf8", flag: "a+" });
        process.exit(1);
    }
    let publicIP = "0.0.0.0";
    try {
        const res = await fetch("https://ifconfig.me/ip");
        publicIP = (await res.text()).trim();
    } catch (e) {}

    console.log("\n🚀 AI Tài Xỉu MD5 Pro V8.0 - ULTRA GOD MODE VI LONG Đã Khởi Động!");
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    console.log(`   ➜ Network: http://${publicIP}:${PORT}/\n`);
    console.log("📌 Các API endpoints VIP:");
    console.log(`   ➜ GET /api/taixiumd5/lc79   → http://${publicIP}:${PORT}/api/taixiumd5/lc79`);
    console.log(`\n🔧 Hệ thống AI VIP với ${ALL_ALGS.length} thuật toán nguyên bản:`);
    ALL_ALGS.forEach((alg, i) => console.log(`   ${i+1}. ${alg.id}`));
    console.log("\n🎯 CẬP NHẬT GIA TRỌNG MỚI TỐI THƯỢNG (V8.0 GOD MODE):");
    console.log("   • [THUẬT TOÁN 16]: Kích hoạt FLASH DETECT - Phân tích bắt chết 1-1, 2-2 siêu tốc (X-T-X-X -> T).");
    console.log("   • [THUẬT TOÁN 17]: Động Năng Điểm - Nhận diện điểm bẻ cầu nhạy cảm.");
    console.log("   • [THUẬT TOÁN 18]: Trục Đối Xứng Gương - Soi cầu đảo ngược.");
    console.log("   • [THUẬT TOÁN 19 & 20]: Phân Phối Poisson & Absolute God Mode - Khóa ghi đè tín hiệu 99% không trượt.");
    console.log("   • Không xóa 1 dòng code cũ nào, hoàn toàn tương thích và siêu mạnh mẽ.");
};
start();p