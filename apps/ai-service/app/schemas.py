"""Request schemas with explicit size limits. The API sends only ids, quantities, amounts and
timestamps — never names, phones or addresses."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

Id = Field(min_length=1, max_length=64)


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# --- forecasting -------------------------------------------------------------
class Point(Model):
    date: date
    quantity: float = Field(ge=0, le=1e7)


class SeriesIn(Model):
    id: str = Id
    history: list[Point] = Field(min_length=1, max_length=1100)


class DateRange(Model):
    start: date
    end: date

    @model_validator(mode="after")
    def ordered(self):
        if self.end < self.start:
            raise ValueError("end must not be before start")
        return self


class ForecastRequest(Model):
    series: list[SeriesIn] = Field(min_length=1, max_length=50)
    horizon: int = Field(default=14, ge=1, le=28)
    end: date | None = None  # last observed day; days without sales up to here count as zero
    weekend_days: list[int] = Field(default=[4, 5], max_length=7)  # Python weekday, Monday=0 (Fri=4, Sat=5)
    ramadan: list[DateRange] = Field(default=[], max_length=20)
    use_ramadan: bool = True
    interval_level: float = Field(default=0.8, ge=0.5, le=0.99)
    models: list[Literal["seasonal_naive_7", "moving_average_28", "hist_gbm"]] = Field(
        default=["seasonal_naive_7", "moving_average_28", "hist_gbm"], min_length=1, max_length=3)
    folds: int = Field(default=3, ge=1, le=5)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)

    @model_validator(mode="after")
    def weekdays(self):
        if any(d < 0 or d > 6 for d in self.weekend_days):
            raise ValueError("weekendDays must be 0 (Monday) … 6 (Sunday)")
        return self


# --- customers ---------------------------------------------------------------
class OrderIn(Model):
    customer_id: str = Id
    at: datetime
    total_minor: int = Field(ge=0, le=10**13)


class SegmentRequest(Model):
    orders: list[OrderIn] = Field(max_length=200_000)
    as_of: datetime


class ChurnRequest(Model):
    orders: list[OrderIn] = Field(max_length=200_000)
    as_of: datetime
    window_days: int = Field(default=60, ge=14, le=365)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)


# --- recommendations ---------------------------------------------------------
class BasketIn(Model):
    customer_id: str | None = Field(default=None, max_length=64)
    at: datetime | None = None
    items: list[str] = Field(min_length=1, max_length=60)


class Weights(Model):
    personal: float = Field(ge=0, le=10)
    assoc: float = Field(ge=0, le=10)
    pop: float = Field(ge=0, le=10)


class RecommendRequest(Model):
    baskets: list[BasketIn] = Field(max_length=100_000)
    items: list[str] = Field(default=[], max_length=100)
    customers: list[str] = Field(default=[], max_length=500)
    unavailable: list[str] = Field(default=[], max_length=2000)
    k: int = Field(default=5, ge=1, le=20)
    min_pair_count: int = Field(default=2, ge=1, le=100)
    weights: Weights | None = None


# --- routing -----------------------------------------------------------------
class LatLng(Model):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class StopIn(Model):
    id: str = Id
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    window_start: datetime | None = None
    window_end: datetime | None = None
    service_minutes: float = Field(default=3.0, ge=0, le=120)


class RouteRequest(Model):
    start: LatLng
    stops: list[StopIn] = Field(min_length=1, max_length=50)
    depart_at: datetime | None = None
    speed_kmh: float = Field(default=25.0, gt=1, le=120)
    road_factor: float = Field(default=1.3, ge=1.0, le=3.0)
    return_to_start: bool = False
    objective: Literal["distance", "lateness"] = "distance"
