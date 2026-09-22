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

  function buildGraphModel(commits) {
    const lanes = [];
    let maxLaneCount = 1;
    const rows = (commits || []).map((commit, rowIndex) => {
      let lane = lanes.indexOf(commit.hash);
      const startsHere = lane < 0;
      if (startsHere) {
        lane = lanes.findIndex(value => !value);
        if (lane < 0) lane = lanes.length;
        lanes[lane] = commit.hash;
      }

      const before = lanes.slice();
      const parents = Array.isArray(commit.parentHashes) ? commit.parentHashes : [];
      const parentLanes = [];
      if (parents.length === 0) {
        lanes[lane] = null;
      } else {
        const existingFirstParentLane = lanes.findIndex((value, index) => index !== lane && value === parents[0]);
        if (existingFirstParentLane >= 0) {
          lanes[lane] = null;
          parentLanes.push(existingFirstParentLane);
        } else {
          lanes[lane] = parents[0];
          parentLanes.push(lane);
        }

        parents.slice(1).forEach(parentHash => {
          let parentLane = lanes.indexOf(parentHash);
          if (parentLane < 0) {
            parentLane = lanes.findIndex(value => !value);
            if (parentLane < 0) parentLane = lanes.length;
            lanes[parentLane] = parentHash;
          }
          parentLanes.push(parentLane);
        });
      }

      while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
      maxLaneCount = Math.max(maxLaneCount, before.length, lanes.length, lane + 1, ...parentLanes.map(value => value + 1));
      return {
        rowIndex,
        lane,
        before,
        after: lanes.slice(),
        parentLanes,
        startsHere,
        isMerge: parents.length > 1
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
    const nextSelection = toggleCompareSelection(selection, commitHash);
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
