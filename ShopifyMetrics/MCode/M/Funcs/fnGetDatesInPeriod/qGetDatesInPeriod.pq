let
    GroupByField = Text.From(ParamGroupByField),
    StartDate = Date.From(ParamReportStartDate),
    EndDate = Date.From(ParamReportEndDate),
    RefreshDate = Date.From(ParamReportRefreshDate),
    WeekStartDay = Number.From(ParamReportWeekStartDay),
    HistoricalTable = ParamHistoricalTable,
    AllowedGroupings = {"day", "week", "month"},

    ValidateInputs = () as nullable any =>
        if not List.Contains(AllowedGroupings, GroupByField) then
            error "GroupByField must be one of: " & Text.Combine(AllowedGroupings, ", ")
        else if StartDate > EndDate then
            error "StartDate must be on or before EndDate."
        else if WeekStartDay < 0 or WeekStartDay > 6 then
            error "WeekStartDay must be a number from 0 to 6, where 0 is Sunday."
        else
            null,

    BuildBasePeriods = () as list =>
        if GroupByField = "day" then
            List.Dates(StartDate, Duration.Days(EndDate - StartDate) + 1, #duration(1, 0, 0, 0))
        else if GroupByField = "week" then
            let
                StartDay = Date.DayOfWeek(StartDate, Day.Sunday),
                Offset = Number.Mod(StartDay - WeekStartDay + 7, 7),
                FirstWeekStart = Date.AddDays(StartDate, -Offset)
            in
                List.Generate(() => FirstWeekStart, each _ <= EndDate, each Date.AddDays(_, 7))
        else
            let
                MonthCount = ((Date.Year(EndDate) - Date.Year(StartDate)) * 12) + Date.Month(EndDate) - Date.Month(StartDate)
            in
                List.Transform({0..MonthCount}, each Date.StartOfMonth(Date.AddMonths(StartDate, _))),

    GetHistoricalDates = () as nullable list =>
        if HistoricalTable = null then
            null
        else
            let
                HasPeriodColumn = Table.HasColumns(HistoricalTable, {GroupByField}),
                HistoricalDates = if HasPeriodColumn then
                    List.Buffer(Table.Column(Table.TransformColumnTypes(HistoricalTable, {{GroupByField, type date}}), GroupByField))
                else
                    null
            in
                HistoricalDates,

    FilterRefreshPeriods = (Periods as table, HistoricalDates as nullable list) as table =>
        if HistoricalDates = null then
            Periods
        else
            Table.SelectRows(Periods, each
                not List.Contains(HistoricalDates, Record.Field(_, GroupByField))
                or Record.Field(_, GroupByField) >= RefreshDate
            ),

    BuildApiRanges = (Periods as table) as table =>
        if GroupByField = "week" then
            let
                WithStart = Table.AddColumn(Periods, "startDate", each Record.Field(_, GroupByField), type date),
                WithEnd = Table.AddColumn(WithStart, "endDate", each Date.AddDays([startDate], 6), type date)
            in
                Table.SelectColumns(WithEnd, {"startDate", "endDate"})
        else
            let
                WithGroupIndex = Table.AddIndexColumn(Periods, "GroupIndex", 0, 1),
                WithGroupId = Table.AddColumn(WithGroupIndex, "GroupId", each [OriginalIndex] - [GroupIndex], Int64.Type),
                Aggregated = Table.Group(WithGroupId, {"GroupId"}, {
                    {"startDate", each List.Min(Table.Column(_, GroupByField)), type date},
                    {"endDate", each
                        if GroupByField = "day" then
                            List.Max(Table.Column(_, GroupByField))
                        else
                            Date.EndOfMonth(List.Max(Table.Column(_, GroupByField))), type date}
                })
            in
                Table.RemoveColumns(Aggregated, {"GroupId"}),

    ValidatedInputs = ValidateInputs(),
    BaseTable = if ValidatedInputs = null then Table.FromList(BuildBasePeriods(), Splitter.SplitByNothing(), {GroupByField}) else #table({GroupByField}, {}),
    TypedBase = Table.TransformColumnTypes(BaseTable, {{GroupByField, type date}}),
    IndexedBase = Table.AddIndexColumn(TypedBase, "OriginalIndex", 0, 1),
    Filtered = FilterRefreshPeriods(IndexedBase, GetHistoricalDates()),
    Sorted = Table.Sort(Filtered, {{GroupByField, Order.Ascending}}),
    Result = BuildApiRanges(Sorted)
in
    Result