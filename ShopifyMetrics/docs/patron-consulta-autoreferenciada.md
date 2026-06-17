# Patrón: Consulta Incremental Autoreferenciada — ShopifyMetrics

**Versión:** v0.1 (borrador — validar prototipo antes de usar en producción)  
**Caso de referencia:** `GetSalesBreakdownByPeriod`

---

## 1. Propósito

Define el patrón estándar para consultas Shopify que deben:

- Traer datos históricos completos desde la API en el primer run.
- En runs posteriores, traer solo los períodos faltantes o recientes (ahorro de llamadas API).
- Acumular el dataset completo en una tabla Excel que se autoalimenta en cada refresh.

---

## 2. Conceptos clave

### fn\*\* / q\*\* (par de función) — mecanismo de inyección

Power Query auto-genera una consulta función (`fn**`) a partir de su par de definición (`q**`). La `fn**` es de solo lectura — no se modifica directamente. Todos los cambios van en el archivo `q**`.

El `q**` define la firma de la función con parámetros como `ParamHistoricalTable as any`. Esos nombres son **parámetros de la función**, no referencias directas a Excel. El valor real se **inyecta** al llamar la `fn**` desde el query de consumo.

```
q**  →  fn** (auto-generado, no editar)
                    ↑
         consumer query lo llama:
         fnGetSalesBreakdownByPeriod(..., HistTable)
                    ↑
         HistTable = try ParamHistoricalTable otherwise null
                    ↑
         ParamHistoricalTable.pq lee TableHistorical desde Excel
```

Ejemplo: `qGetSalesBreakdownByPeriod.pq` define la función → Power Query crea `fnGetSalesBreakdownByPeriod` automáticamente.

### ParamReportRefreshDate

Fecha de corte para refresh incremental. Períodos **antes** de esta fecha que ya existen en el histórico se **omiten** (no se re-fetchan). Períodos **en o después** de esta fecha siempre se re-fetchan, para capturar correcciones o datos tardíos de Shopify.

### TableHistorical

Tabla Excel donde se acumula el dataset completo. Es a la vez el **output** del query principal y el **input** del siguiente refresh (autoreferencia).

`Params/ParamHistoricalTable.pq` lee esta tabla desde Excel via `Excel.CurrentWorkbook()`. El consumer query inyecta ese valor a la `fn**` al llamarla. Otros queries derivados (agregaciones semanales/mensuales) también pueden inyectar `ParamHistoricalTable` para operar sobre el histórico acumulado sin llamar a la API.

---

## 3. Arquitectura del patrón

Cada topic (ej. SalesBreakdown) genera **tres queries autoreferenciados independientes**, uno por granularidad:

```
ParamNombreTablaHistDiario  = "SalesBreakdownDaily"   (string en Excel)
ParamNombreTablaHistSemanal = "SalesBreakdownWeekly"
ParamNombreTablaHistMensual = "SalesBreakdownMonthly"
```

### Ciclo por granularidad (mismo patrón × 3)

```
┌─────────────────────────────────────────────────────────────────┐
│  Run N — SalesBreakdownDaily                                    │
│                                                                 │
│  Excel.CurrentWorkbook(){[Name=ParamNombreTablaHistDiario]}     │
│                    │                                            │
│                    ▼                                            │
│         HistStable (period < RefreshDate)                       │
│                    │                                            │
│  fnGetSalesBreakdownByPeriod(... HistTable)                     │
│    └─► fnGetDatesInPeriod (filtra períodos ya cubiertos)        │
│    └─► Shopify API (solo faltantes + >= RefreshDate)            │
│                    │                                            │
│               FreshRows                                         │
│                    │                                            │
│  Table.Combine({HistStable, FreshRows})                         │
│                    │                                            │
│                    ▼                                            │
│          SalesBreakdownDaily (sobreescribe)  ◄──────────────────┘
└─────────────────────────────────────────────────────────────────┘

SalesBreakdownWeekly  → mismo ciclo, tabla propia, granularidad week
SalesBreakdownMonthly → mismo ciclo, tabla propia, granularidad month
```

### Invariante central

Cada tabla `[Topic][Granularidad]` **siempre contiene el dataset completo** para esa granularidad. Cada refresh sobreescribe con `HistStable + FreshRows`.

### Queries derivados (sin API)

`ParamHistoricalTable` es un punto de acceso compartido al dataset acumulado. Otros queries pueden inyectarlo para producir agregaciones sin llamar a Shopify:

```
ParamHistoricalTable (TableHistorical diario)
    │
    ├── qSalesBreakdownByPeriod   ← self-referencing, llama API, carga a TableHistorical
    ├── qSalesWeekly              ← lee histórico, agrupa por semana, sin API
    └── qSalesMonthly             ← lee histórico, agrupa por mes, sin API
```

Los queries derivados no se autoreferencian — solo leen `ParamHistoricalTable` y transforman.

---

## 4. Componentes reutilizables (genérico — aplica a todas las consultas)

| Componente | Responsabilidad | Cambia por consulta |
|---|---|---|
| `fnGetDatesInPeriod` | Genera períodos; filtra los ya cubiertos en histórico | No |
| `try ParamHistoricalTable otherwise null` | Manejo seguro del primer run | No |
| Filtro `HistStable` | Rows de histórico con `period < RefreshDate` | Solo el nombre de columna de período |
| `Table.Combine({HistStable, FreshRows})` | Ensambla dataset completo | No |
| `Table.Sort` por columna período | Ordena output final | Solo el nombre de columna de período |
| Carga a `TableHistorical` | Cierra el ciclo de autoreferencia | No |

---

## 5. Componentes específicos de GetSalesBreakdownByPeriod

| Componente | Valor |
|---|---|
| Función base | `fnGetSalesBreakdownByPeriod` |
| Fuente ShopifyQL | `FROM sales SHOW [20 métricas] GROUP BY [day\|month]` |
| Executor | `fnShopifyQL` |
| Columna de período | `day`, `week`, o `month` (según `ParamGroupByField`) |
| Timestamp de auditoría | `refresh_date_SalesBreakdown` (se preserva original en HistStable) |
| Métricas | `orders`, `gross_sales`, `net_sales`, `discounts`, `taxes`, `cost_of_goods_sold`, `gross_profit`, y 13 más |

---

## 6. Implementación paso a paso

### Fase 1 — Primer run (carga inicial)

**Prerequisitos:**
- Parámetros configurados en Excel: `ParamShopName`, `ParamApiVersion`, `ParamAccessToken`, `ParamReportStartDate`, `ParamReportEndDate`, `ParamReportRefreshDate`, `ParamReportWeekStartDay`, `ParamGroupByField`
- `TableHistorical` aún no existe en el workbook

**Pasos:**

1. Crear el query principal (ver sección 7) en Power Query.
2. Configurar `ParamReportStartDate` = fecha inicial del histórico deseado.
3. Configurar `ParamReportRefreshDate` = misma fecha que `ParamReportStartDate` (o cualquier fecha anterior al rango). Así todos los períodos se tratan como "a fetchear".
4. Ejecutar el query → trae todos los períodos desde API → carga a `TableHistorical`.
5. Verificar que `TableHistorical` existe en el workbook con datos completos.

> **Nota — primer run y `try`:** El query usa `try ParamHistoricalTable otherwise null` para manejar el caso donde `TableHistorical` no existe aún. **Validar en prototipo** que `try` atrapa el error de `Excel.CurrentWorkbook()` cuando la tabla no existe. Si no funciona: crear manualmente una tabla vacía llamada `TableHistorical` con las columnas correctas antes del primer run.

### Fase 2 — Autoreferenciación (runs posteriores)

Después del primer run exitoso, el ciclo es automático:

1. `TableHistorical` existe con datos del run anterior.
2. `ParamHistoricalTable` la lee via named range.
3. El query filtra períodos ya cubiertos (< `RefreshDate`), re-fetcha solo los recientes.
4. Combina `HistStable + FreshRows` → sobreescribe `TableHistorical`.
5. Siguiente refresh repite desde paso 2.

**Para refresh incremental normal:**
- Mover `ParamReportRefreshDate` hacia adelante (ej. últimos 7 días) para re-fetchar solo el período reciente.
- `ParamReportStartDate` y `ParamReportEndDate` controlan el rango total del reporte.

---

## 7. Código del query principal

Archivo: `[NombreConsulta].pq` (no va en `Funcs/` — es un query de consumo, no una función)

```powerquery
let
    GroupByField = Text.From(ParamGroupByField),
    RefreshDate  = Date.From(ParamReportRefreshDate),
    PeriodColumn = if GroupByField = "week" then "week" else GroupByField,

    // Primer run: si TableHistorical no existe, pasar null a la función
    // PENDIENTE: validar que try atrapa el error en primer run
    HistTable = try ParamHistoricalTable otherwise null,

    // Traer de API solo períodos faltantes o >= RefreshDate
    FreshRows = fnGetSalesBreakdownByPeriod(
        ParamShopName,
        ParamApiVersion,
        ParamAccessToken,
        Date.From(ParamReportStartDate),
        Date.From(ParamReportEndDate),
        RefreshDate,
        Number.From(ParamReportWeekStartDay),
        GroupByField,
        HistTable
    ),

    // Histórico estable: períodos antes de RefreshDate que no se re-fetcharon
    HistStable = if HistTable = null
                 then #table(Table.ColumnNames(FreshRows), {})
                 else Table.SelectRows(
                          Table.TransformColumnTypes(HistTable, {{PeriodColumn, type date}}),
                          each Record.Field(_, PeriodColumn) < RefreshDate
                      ),

    // Dataset completo: histórico estable + rows frescos de API
    Combined = Table.Combine({HistStable, FreshRows}),
    Result   = Table.Sort(Combined, {{PeriodColumn, Order.Ascending}})
in
    Result
```

**Configuración de carga en Excel:**
- Load to: tabla llamada `TableHistorical` en hoja dedicada
- Refresh: manual o programado según necesidad

---

## 8. Template para nuevas consultas Shopify

Para implementar una nueva consulta (ej. `GetOrdersByPeriod`, `GetInventoryByProduct`):

### Lo que cambia

| Elemento | GetSalesBreakdownByPeriod | Nueva consulta |
|---|---|---|
| Función base | `fnGetSalesBreakdownByPeriod` | `fn[NuevaConsulta]` |
| `q**` de definición | `qGetSalesBreakdownByPeriod.pq` | `q[NuevaConsulta].pq` |
| ShopifyQL / GraphQL | `FROM sales SHOW ...` | Query específico de la consulta |
| Executor | `fnShopifyQL` | `fnShopifyQL` o `fnShopifyGraphQL` |
| Columna de período | `day` / `week` / `month` | Depende del agrupamiento |
| Timestamp de auditoría | `refresh_date_SalesBreakdown` | `refresh_date_[NombreConsulta]` |
| Tabla histórica | `TableHistorical` | `Table[NombreConsulta]Historical` |
| Named range param | `ParamHistoricalTable` | `Param[NombreConsulta]HistoricalTable` |

### Lo que no cambia

- Patrón `try ParamHistoricalTable otherwise null`
- Lógica de `HistStable` (filtro por `period < RefreshDate`)
- `Table.Combine({HistStable, FreshRows})`
- `Table.Sort` por columna período
- Uso de `fnGetDatesInPeriod` dentro de la función base (si la consulta es por período)

### Estructura de archivos para nueva consulta

```
ShopifyMetrics/MCode/M/
├── Funcs/
│   └── fn[NuevaConsulta]/
│       ├── fn[NuevaConsulta].pq    ← auto-generado por Power Query, no editar
│       └── q[NuevaConsulta].pq     ← definición de la función (editar aquí)
├── Params/
│   └── Param[NuevaConsulta]HistoricalTable.pq   ← si la consulta es independiente
└── [NombreQuery].pq                ← query de consumo con lógica de combine
```

---

## 9. Decisiones de diseño tomadas

| Decisión | Alternativa descartada | Razón |
|---|---|---|
| Combine en query de consumo, no en la función | Combine dentro de `fn**` | La función queda reutilizable para casos sin autoreferencia |
| Una sola tabla (`TableHistorical`) como output e input | Tabla separada de staging | Menos pasos manuales, sin duplicación |
| `HistStable` = rows donde `period < RefreshDate` | Union con deduplicación posterior | `fnGetDatesInPeriod` ya garantiza que no hay solapamiento |
| `refresh_date_*` preservado en `HistStable` | Sobreescribir con datetime actual | Auditoría: conservar la fecha real en que cada período fue fetched |
| `ParamHistoricalTable` como parámetro inyectable (no hardcoded en la función) | Leer `Excel.CurrentWorkbook()` directamente dentro de `fn**` | La función queda agnóstica al origen del histórico; el mismo `ParamHistoricalTable` puede alimentar queries derivados (semanal, mensual) sin pasar por API |

---

## 10. Pendientes de validación en prototipo

- [ ] `try ParamHistoricalTable otherwise null` atrapa error cuando `TableHistorical` no existe en primer run. Si falla: crear tabla vacía manualmente como Fase 1 alternativa.
- [ ] `Table.Combine({HistStable, FreshRows})` no genera conflictos de esquema cuando `FreshRows` es `EmptyOutputTable()` (tabla tipada vacía).
- [ ] Refresh order en Excel: confirmar que `ParamHistoricalTable` se evalúa antes del query principal en el grafo de dependencias.
