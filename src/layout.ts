/**
 * 正文实际的右边缘（屏幕坐标）。
 * 有的主题（如 Minimal）让编辑区铺满整个窗格、只限制每一行的宽度，
 * 所以不能用容器的右边缘，而是取各行右边缘里出现次数最多的值。
 */
export function textRight(lines: ArrayLike<Element>, fallback: number): number {
	const counts = new Map<number, number>();
	for (const el of Array.from(lines)) {
		const right = Math.round(el.getBoundingClientRect().right);
		if (right) counts.set(right, (counts.get(right) ?? 0) + 1);
	}
	let best = fallback;
	let most = 0;
	for (const [right, count] of counts) {
		if (count > most || (count === most && right < best)) {
			best = right;
			most = count;
		}
	}
	return best;
}

/**
 * 计算一列卡片的纵向位置，避免重叠。
 * anchor 为当前批注的下标：它对齐自己的原文，前面的卡片往上让、后面的往下排；
 * 没有当前批注（anchor < 0）时从上往下依次排。
 */
export function stackCards(tops: number[], heights: number[], anchor: number, gap: number): number[] {
	const ys = tops.slice();
	if (anchor < 0) {
		let bottom = -Infinity;
		for (let i = 0; i < ys.length; i++) {
			ys[i] = Math.max(tops[i], bottom + gap);
			bottom = ys[i] + heights[i];
		}
		return ys;
	}
	let limit = ys[anchor] - gap;
	for (let i = anchor - 1; i >= 0; i--) {
		ys[i] = Math.min(tops[i], limit - heights[i]);
		limit = ys[i] - gap;
	}
	let bottom = ys[anchor] + heights[anchor];
	for (let i = anchor + 1; i < ys.length; i++) {
		ys[i] = Math.max(tops[i], bottom + gap);
		bottom = ys[i] + heights[i];
	}
	return ys;
}
