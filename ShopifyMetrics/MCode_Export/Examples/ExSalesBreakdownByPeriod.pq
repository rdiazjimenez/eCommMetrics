// ExSalesBreakdownByPeriod
// Example: sales breakdown via fnGetSalesBreakdownByPeriod.
// Change GroupByField to "week" or "month" to test other grains.
let
    GroupByField = "day",
    StartDate = Date.From(ParamReportStartDate),
    EndDate = Date.From(ParamReportEndDate),
    RefreshDate = Date.From(ParamReportRefreshDate),
    WeekStartDay = Number.From(ParamReportWeekStartDay),

    ValidStartDate = if StartDate > EndDate
                     then error "ParamReportStartDate must be on or before ParamReportEndDate."
                     else StartDate,

    Source = fnGetSalesBreakdownByPeriod(
        ParamShopName,
        ParamApiVersion,
        ParamAccessToken,
        ValidStartDate,
        EndDate,
        RefreshDate,
        WeekStartDay,
        GroupByField,
        ParamHistoricalTable
    )
in
    Source;

[ FunctionQueryBinding = "{""exemplarFormulaName"":""qGetDatesInPeriod""}" ]