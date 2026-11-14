"""Large GCOV windows are averaged while read (canopy/io_gcov.py): the means match."""

import numpy as np

from canopy import io_gcov


class _Arr:
    def __init__(self, a):
        self.a = a

    def __getitem__(self, idx):
        return self.a[idx]


def test_looks_only_above_the_pixel_limit():
    assert io_gcov.looks_for(2_800_000) == 1  # the largest flood site
    assert io_gcov.looks_for(61_000_000) == 4  # the fire box
    assert io_gcov.looks_for(200_000_000) == 7


def test_looked_read_is_the_block_mean_without_invalid_samples():
    rng = np.random.default_rng(3)
    a = rng.uniform(0.01, 0.5, (9, 8))
    a[0, 0] = 0.0  # invalid: not counted
    a[5, 3] = np.nan
    got = io_gcov._looked(_Arr(a), slice(0, 9), slice(0, 8), 2)
    assert got.shape == (4, 4)  # the odd last row is dropped
    blk = a[0:2, 0:2].copy()
    blk[0, 0] = np.nan
    assert np.isclose(got[0, 0], np.nanmean(blk))
    assert np.isclose(got[2, 1], np.nanmean(a[4:6, 2:4]))
