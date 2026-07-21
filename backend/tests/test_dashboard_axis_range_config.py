import unittest

from pydantic import ValidationError

from app.schemas.dashboard import (
    AreaChartWidgetConfig,
    BarChartWidgetConfig,
    DashboardRuntimeWidgetType,
    LineChartWidgetConfig,
)
from app.services.dashboard_widget_config import (
    dashboard_widget_config_to_json,
    default_dashboard_widget_config,
)


def chart_config(**overrides):
    return {
        "aggregation": "sum",
        "color": {"colors": ["#2563eb"]},
        "xKey": "category",
        "yKey": "amount",
        **overrides,
    }


class DashboardAxisRangeConfigTests(unittest.TestCase):
    def test_cartesian_chart_models_accept_data_focus_and_manual_ranges(self):
        for model in (BarChartWidgetConfig, LineChartWidgetConfig, AreaChartWidgetConfig):
            with self.subTest(model=model.__name__, mode="data_focus"):
                parsed = model.model_validate(chart_config(valueAxisRangeMode="data_focus"))
                self.assertEqual(parsed.value_axis_range_mode, "data_focus")

            with self.subTest(model=model.__name__, mode="manual_min"):
                parsed = model.model_validate(chart_config(
                    valueAxisRangeMode="manual",
                    valueAxisMin=975,
                ))
                self.assertEqual(parsed.value_axis_min, 975)
                self.assertIsNone(parsed.value_axis_max)

            with self.subTest(model=model.__name__, mode="manual_both"):
                parsed = model.model_validate(chart_config(
                    valueAxisRangeMode="manual",
                    valueAxisMin=975,
                    valueAxisMax=1005,
                ))
                self.assertEqual(parsed.value_axis_max, 1005)

    def test_invalid_manual_ranges_fail_closed(self):
        invalid_configs = (
            chart_config(valueAxisRangeMode="manual"),
            chart_config(valueAxisRangeMode="manual", valueAxisMin=10, valueAxisMax=10),
            chart_config(valueAxisRangeMode="manual", valueAxisMin=11, valueAxisMax=10),
            chart_config(valueAxisRangeMode="data_focus", valueAxisMin=10),
            chart_config(valueAxisRangeMode="manual", valueAxisMin=float("inf")),
        )
        for config in invalid_configs:
            with self.subTest(config=config):
                with self.assertRaises(ValidationError):
                    BarChartWidgetConfig.model_validate(config)

    def test_nested_source_config_cannot_bypass_range_validation(self):
        with self.assertRaises(ValidationError):
            BarChartWidgetConfig.model_validate(chart_config(sourceConfig={
                **chart_config(),
                "valueAxisRangeMode": "manual",
                "valueAxisMin": 100,
                "valueAxisMax": 90,
            }))

    def test_manual_range_round_trips_through_persisted_camel_case_config(self):
        parsed = BarChartWidgetConfig.model_validate(chart_config(
            valueAxisRangeMode="manual",
            valueAxisMin=975,
            valueAxisMax=1005,
        ))

        self.assertEqual(
            dashboard_widget_config_to_json(DashboardRuntimeWidgetType.BAR_CHART, parsed),
            chart_config(
                filters=[],
                valueAxisRangeMode="manual",
                valueAxisMin=975.0,
                valueAxisMax=1005.0,
            ),
        )

    def test_new_default_cartesian_config_declares_backward_compatible_mode(self):
        for widget_type in (
            DashboardRuntimeWidgetType.BAR_CHART,
            DashboardRuntimeWidgetType.LINE_CHART,
            DashboardRuntimeWidgetType.AREA_CHART,
        ):
            with self.subTest(widget_type=widget_type.value):
                payload = dashboard_widget_config_to_json(
                    widget_type,
                    default_dashboard_widget_config(widget_type),
                )
                self.assertEqual(payload["valueAxisRangeMode"], "default")


if __name__ == "__main__":
    unittest.main()
