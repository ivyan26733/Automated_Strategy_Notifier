from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from typing import Any


@dataclass
class Signal:
    strategy_name:       str
    signal_type:         str
    symbol:              str
    signal_date:         date
    price:               float
    weekly_close:        float | None    = None
    ema9:                float | None    = None
    ema20:               float | None    = None
    ema_difference:      float | None    = None
    ema_difference_pct:  float | None    = None
    breakout_reference:  float | None    = None
    breakout_pct:        float | None    = None
    sector:              str             = ""
    industry:            str             = ""
    extra:               dict[str, Any]  = field(default_factory=dict)


class Strategy(ABC):
    name: str

    @abstractmethod
    def generate_signals(self, symbol: str, weekly: Any, sector: str, industry: str) -> list[Signal]:
        """
        Generate signals for one stock.

        Parameters
        ----------
        symbol  : NSE ticker (e.g. "RELIANCE.NS")
        weekly  : DataFrame returned by build_weekly() — indexed by week_start,
                  columns Open/High/Low/Close/Volume/observation_date/is_developing
        sector  : sector string from universe (may be empty)
        industry: industry string from universe (may be empty)

        Returns a (possibly empty) list of Signal objects.
        """
