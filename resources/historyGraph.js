(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepositoryHistoryGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ROW_HEIGHT = 32;
  const LANE_GAP = 18;
  const LANE_INSET = 18;
  const MIN_GRAPH_WIDTH = 76;

  function laneX(lane) {
    return LANE_INSET + (lane * LANE_GAP);
  }

  // The commit HEAD points at: the current branch's ref, or a bare "HEAD" when detached.
  function findHeadHash(commits) {
    const head = commits.find(commit => (commit.refs || []).some(ref => ref && (ref.isCurrent || ref.name === 'HEAD')));
    return head ? head.hash : '';
  }

  // The current branch's upstream (origin/<branch> first) when it is ahead of HEAD and its
  // first-parent line runs straight down to HEAD: the main column then starts at the upstream
  // tip, so "behind by n" reads as one line, as in Git Graph. A diverged upstream is left alone.
  function findUpstreamTip(commits, byHash, headHash) {
    const head = byHash.get(headHash);
    const current = head && (head.refs || []).find(ref => ref && ref.isCurrent);
    if (!current || !current.name) return '';
    const suffix = `/${current.name}`;
    const candidates = commits.filter(commit => commit.hash !== headHash && (commit.refs || []).some(ref =>
      ref && ref.kind === 'remote-branch' && typeof ref.name === 'string' && ref.name.endsWith(suffix)));
    candidates.sort((a, b) => Number(!(a.refs || []).some(ref => ref && ref.name === `origin${suffix}`)) -
      Number(!(b.refs || []).some(ref => ref && ref.name === `origin${suffix}`)));
    for (const candidate of candidates) {
      const seen = new Set();
      for (let hash = candidate.hash; hash && byHash.has(hash) && !seen.has(hash);) {
        if (hash === headHash) return candidate.hash;
        seen.add(hash);
        hash = (byHash.get(hash).parentHashes || [])[0];
      }
    }
    return '';
  }

  /**
   * Lays commits (newest first) out in lanes, Git Graph style: the current branch's first-parent
   * chain stays in column 0, and every branch path keeps one column and one colour from its tip
   * until it merges or ends. Freed columns are reused, with a new colour.
   *
   * Per row: `lane`/`color` of the commit; `before`/`after` the hash each lane expects above and
   * below the row, with `beforeColors`/`afterColors`; `incomingLanes`, other lanes that end at this
   * commit (its other children); `parentLanes`/`parentColors`, where the edges to its parents go.
   */
  function buildGraphModel(commits, options) {
    const list = commits || [];
    const byHash = new Map(list.map(commit => [commit.hash, commit]));
    const headHash = (options && options.headHash) || findHeadHash(list);
    const headChain = new Set();
    const chainTip = findUpstreamTip(list, byHash, headHash) || headHash;
    for (let hash = chainTip; hash && byHash.has(hash) && !headChain.has(hash);) {
      headChain.add(hash);
      hash = (byHash.get(hash).parentHashes || [])[0];
    }
    const reserved = headChain.size > 0;
    const lanes = [];
    const colors = [];
    let nextColor = reserved ? 1 : 0;
    let maxLaneCount = 1;
    const freeLane = () => {
      for (let index = reserved ? 1 : 0; ; index += 1) if (!lanes[index]) return index;
    };
    const open = (lane, hash, color) => {
      lanes[lane] = hash;
      colors[lane] = color;
    };

    const rows = list.map((commit, rowIndex) => {
      const onHead = headChain.has(commit.hash);
      const expecting = [];
      lanes.forEach((value, index) => { if (value === commit.hash) expecting.push(index); });
      const lane = onHead ? 0 : expecting.length ? expecting[0] : freeLane();
      const startsHere = !expecting.includes(lane);
      if (startsHere) colors[lane] = onHead ? 0 : nextColor++;
      const before = lanes.slice();
      const beforeColors = colors.slice();
      const incomingLanes = expecting.filter(index => index !== lane);
      incomingLanes.forEach(index => { lanes[index] = null; });
      const color = colors[lane];

      const parents = Array.isArray(commit.parentHashes) ? commit.parentHashes : [];
      const parentLanes = [];
      const parentColors = [];
      if (parents.length === 0) {
        lanes[lane] = null;
      } else {
        const first = parents[0];
        const other = lanes.findIndex((value, index) => index !== lane && value === first);
        if (!onHead && other >= 0) {
          // Another lane already leads to this parent: this branch ends by joining it.
          lanes[lane] = null;
          parentLanes.push(other);
          parentColors.push(color);
        } else {
          lanes[lane] = first;
          parentLanes.push(lane);
          parentColors.push(color);
        }
        parents.slice(1).forEach(parentHash => {
          let parentLane = lanes.indexOf(parentHash);
          if (parentLane < 0) {
            // Even a commit of the current branch opens its own lane here; when its row comes it
            // is drawn in column 0 and this lane curves into it.
            parentLane = freeLane();
            open(parentLane, parentHash, nextColor++);
          }
          parentLanes.push(parentLane);
          parentColors.push(colors[parentLane]);
        });
      }

      while (lanes.length && !lanes[lanes.length - 1]) { lanes.pop(); colors.length = lanes.length; }
      maxLaneCount = Math.max(maxLaneCount, before.length, lanes.length, lane + 1, ...parentLanes.map(value => value + 1));
      return {
        rowIndex,
        lane,
        color,
        before,
        after: lanes.slice(),
        beforeColors,
        afterColors: colors.slice(),
        incomingLanes,
        parentLanes,
        parentColors,
        startsHere,
        isMerge: parents.length > 1,
        isHead: commit.hash === headHash
      };
    });

    return {
      rows,
      laneCount: maxLaneCount,
      width: Math.max(MIN_GRAPH_WIDTH, (LANE_INSET * 2) + ((maxLaneCount - 1) * LANE_GAP)),
      height: rows.length * ROW_HEIGHT,
      rowHeight: ROW_HEIGHT
    };
  }

  function toggleCompareSelection(selection, commitHash) {
    const next = Array.isArray(selection) ? selection.filter(Boolean).slice(0, 2) : [];
    const selectedIndex = next.indexOf(commitHash);
    if (selectedIndex >= 0) {
      next.splice(selectedIndex, 1);
      return next;
    }
    if (next.length === 2) next.shift();
    next.push(commitHash);
    return next;
  }

  function transitionCompareSelection(selection, commitHash, comparisonActive) {
    const current = Array.isArray(selection) ? selection.filter(Boolean).slice(0, 2) : [];
    const selectedIndex = current.indexOf(commitHash);
    let nextSelection;
    if (selectedIndex >= 0) {
      nextSelection = current.slice();
      nextSelection.splice(selectedIndex, 1);
    } else if (current.length < 2) {
      nextSelection = current.concat(commitHash);
    } else {
      nextSelection = [commitHash];
    }
    return {
      selection: nextSelection,
      action: nextSelection.length === 2 ? 'compare' : comparisonActive ? 'parent' : 'none'
    };
  }

  function normalizeHistoryFilters(saved) {
    const value = saved && typeof saved === 'object' ? saved : {};
    return {
      branch: typeof value.branch === 'string' ? value.branch : '',
      includeRemotes: value.includeRemotes !== false,
      search: typeof value.search === 'string' ? value.search : ''
    };
  }

  return {
    ROW_HEIGHT,
    laneX,
    buildGraphModel,
    toggleCompareSelection,
    transitionCompareSelection,
    normalizeHistoryFilters
  };
});
