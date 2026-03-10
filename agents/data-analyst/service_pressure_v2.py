"""
Service Pressure Index v2 - Corrected calculation
Only uses POIs with VERIFIED opening hours AND popular_times data (valid oh_vec).
"""
import pickle
import sqlite3
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D
import warnings
warnings.filterwarnings('ignore')

print("=" * 70)
print("SERVICE PRESSURE INDEX v2 - CORRECTED CALCULATION")
print("=" * 70)

# ============================================================
# 1. Load Data
# ============================================================
print("\n[1] Loading spatial framework...")
with open('/Volumes/Data/PDF_tool/research/cache/spatial_framework.pkl', 'rb') as f:
    sf = pickle.load(f)
poi_data = sf['poi_data']
print(f"    Total POIs in spatial framework: {len(poi_data)}")

# 2. Define target categories
ESSENTIAL_CATS = {"Supermarket", "Convenience store", "Grocery store"}
DISCRETIONARY_CATS = {"Cafe", "Coffee shop", "Restaurant"}
ALL_TARGET_CATS = ESSENTIAL_CATS | DISCRETIONARY_CATS

# 3. Filter to ONLY target categories with valid oh_vec
poi_data['has_valid_oh'] = poi_data['oh_vec'].apply(
    lambda x: x is not None and isinstance(x, np.ndarray) and len(x) == 168
)
poi_data['is_target_cat'] = poi_data['main_category'].isin(ALL_TARGET_CATS)

valid_poi_mask = poi_data['has_valid_oh'] & poi_data['is_target_cat']
print(f"\n    Valid target POIs (verified OH + target category): {valid_poi_mask.sum()}")
print(poi_data[valid_poi_mask]['main_category'].value_counts().to_string())

# Create oh_matrix for VALID POIs only
valid_poi_df = poi_data[valid_poi_mask].copy().reset_index(drop=True)
valid_poi_df['orig_idx'] = poi_data[valid_poi_mask].index.tolist()

oh_matrix = np.stack(valid_poi_df['oh_vec'].values)  # (n_valid, 168)
valid_is_essential = valid_poi_df['main_category'].isin(ESSENTIAL_CATS).values
valid_is_discretionary = valid_poi_df['main_category'].isin(DISCRETIONARY_CATS).values

# Map original poi indices to new valid_poi row positions
orig_to_valid_pos = {orig_idx: i for i, orig_idx in enumerate(valid_poi_df['orig_idx'])}

print(f"\n    oh_matrix shape: {oh_matrix.shape}")

# 4. Load isochrone cache
print("\n[2] Loading isochrone cache...")
with open('/Volumes/Data/PDF_tool/research/cache/building_isochrone_results.pkl', 'rb') as f:
    isochrone = pickle.load(f)
print(f"    Isochrone entries: {len(isochrone)}")

# 5. Load building populations
print("\n[3] Loading building populations...")
node_summary = pd.read_csv('/Volumes/Data/PDF_tool/research/output/building_qc_node_summary.csv')
node_pop = node_summary.groupby('node_id')['population'].first().to_dict()
print(f"    Buildings with population: {len(node_pop)}")

# ============================================================
# 2. Core Computation
# ============================================================
print("\n[4] Computing service pressure (168h x all buildings)...")
print("    This may take a few minutes...")

results = []
skip_no_pop = 0
skip_no_valid_poi = 0
processed = 0

for node_id, iso_data in isochrone.items():
    pop = node_pop.get(int(node_id), 0)
    if pop <= 0:
        skip_no_pop += 1
        continue

    inner_indices = iso_data['inner_poi_indices']

    # Map to valid positions
    valid_positions = [orig_to_valid_pos[idx] for idx in inner_indices
                       if idx in orig_to_valid_pos]

    if not valid_positions:
        skip_no_valid_poi += 1
        continue

    valid_pos_arr = np.array(valid_positions, dtype=int)
    is_ess = valid_is_essential[valid_pos_arr]
    is_dis = valid_is_discretionary[valid_pos_arr]

    ess_positions = valid_pos_arr[is_ess]
    dis_positions = valid_pos_arr[is_dis]

    n_ess_total = len(ess_positions)
    n_dis_total = len(dis_positions)

    # Vectorized: compute n_open for each hour
    if n_ess_total > 0:
        n_open_ess = oh_matrix[ess_positions, :].sum(axis=0)  # (168,)
    else:
        n_open_ess = np.zeros(168, dtype=int)

    if n_dis_total > 0:
        n_open_dis = oh_matrix[dis_positions, :].sum(axis=0)  # (168,)
    else:
        n_open_dis = np.zeros(168, dtype=int)

    for h in range(168):
        sp_ess = pop / n_open_ess[h] if n_open_ess[h] > 0 else np.nan
        sp_dis = pop / n_open_dis[h] if n_open_dis[h] > 0 else np.nan
        results.append({
            'node_id': int(node_id),
            'population': pop,
            'hour_idx': h,
            'day_of_week': h // 24,
            'hour_of_day': h % 24,
            'pressure_essential': sp_ess,
            'pressure_discretionary': sp_dis,
            'n_ess_total': n_ess_total,
            'n_dis_total': n_dis_total,
        })
    processed += 1

    if processed % 5000 == 0:
        print(f"    Processed {processed} buildings...")

print(f"\n    Processed: {processed} buildings")
print(f"    Skipped (no population): {skip_no_pop}")
print(f"    Skipped (no valid POI in isochrone): {skip_no_valid_poi}")

df = pd.DataFrame(results)
print(f"    Result rows: {len(df)}")

# ============================================================
# 3. Hourly Aggregation
# ============================================================
print("\n[5] Computing population-weighted hourly aggregations...")

hourly = []
for h in range(168):
    hdf = df[df['hour_idx'] == h]
    n_buildings = len(hdf)

    # Essential
    ess_valid = hdf[hdf['pressure_essential'].notna()]
    if len(ess_valid) > 0:
        ess_mean = (ess_valid['pressure_essential'] * ess_valid['population']).sum() / ess_valid['population'].sum()
        ess_pct_noservice = 1 - len(ess_valid) / n_buildings
    else:
        ess_mean = np.nan
        ess_pct_noservice = 1.0

    # Discretionary
    dis_valid = hdf[hdf['pressure_discretionary'].notna()]
    if len(dis_valid) > 0:
        dis_mean = (dis_valid['pressure_discretionary'] * dis_valid['population']).sum() / dis_valid['population'].sum()
        dis_pct_noservice = 1 - len(dis_valid) / n_buildings
    else:
        dis_mean = np.nan
        dis_pct_noservice = 1.0

    hourly.append({
        'hour_idx': h,
        'day_of_week': h // 24,
        'hour_of_day': h % 24,
        'essential_pressure': ess_mean,
        'essential_pct_noservice': ess_pct_noservice,
        'discretionary_pressure': dis_mean,
        'discretionary_pct_noservice': dis_pct_noservice,
        'n_buildings': n_buildings,
    })

hourly_df = pd.DataFrame(hourly)

# ============================================================
# 4. Key Statistics
# ============================================================
print("\n" + "=" * 70)
print("KEY STATISTICS")
print("=" * 70)

# Daytime: Mon-Fri (0-4), 10am-8pm (10-20)
daytime_mask = (hourly_df['day_of_week'] <= 4) & (hourly_df['hour_of_day'] >= 10) & (hourly_df['hour_of_day'] <= 20)
# Nighttime: Mon-Fri (0-4), 0am-5am (0-5)
nighttime_mask = (hourly_df['day_of_week'] <= 4) & (hourly_df['hour_of_day'] <= 5)

daytime_df = hourly_df[daytime_mask]
nighttime_df = hourly_df[nighttime_mask]

def weighted_mean_ignoring_nan(series, weights=None):
    mask = series.notna()
    if mask.sum() == 0:
        return np.nan
    if weights is None:
        return series[mask].mean()
    return (series[mask] * weights[mask]).sum() / weights[mask].sum()

# Population-weighted mean: use building counts as proxy weight
daytime_ess = weighted_mean_ignoring_nan(daytime_df['essential_pressure'])
daytime_dis = weighted_mean_ignoring_nan(daytime_df['discretionary_pressure'])
nighttime_ess = weighted_mean_ignoring_nan(nighttime_df['essential_pressure'])
nighttime_dis = weighted_mean_ignoring_nan(nighttime_df['discretionary_pressure'])

print(f"\n  Daytime (Mon-Fri, 10am-8pm) Population-Weighted Mean Pressure:")
print(f"    Essential (supermarket/convenience/grocery): {daytime_ess:.1f} residents/open facility")
print(f"    Discretionary (cafe/coffee/restaurant):     {daytime_dis:.1f} residents/open facility")

print(f"\n  Nighttime (Mon-Fri, 0am-5am) Population-Weighted Mean Pressure:")
print(f"    Essential:    {nighttime_ess:.1f} residents/open facility")
print(f"    Discretionary: {nighttime_dis:.1f} residents/open facility")

print(f"\n  Pressure Ratio (Nighttime / Daytime):")
if daytime_ess > 0:
    print(f"    Essential:    {nighttime_ess / daytime_ess:.2f}x")
if daytime_dis > 0:
    print(f"    Discretionary: {nighttime_dis / daytime_dis:.2f}x")

# 3am statistics
am3_rows = hourly_df[hourly_df['hour_of_day'] == 3]
print(f"\n  % Buildings with NO SERVICE at 3am:")
print(f"    Essential:    {am3_rows['essential_pct_noservice'].mean() * 100:.1f}%")
print(f"    Discretionary: {am3_rows['discretionary_pct_noservice'].mean() * 100:.1f}%")

# 12pm (noon) statistics
pm12_rows = hourly_df[hourly_df['hour_of_day'] == 12]
ess_3am = am3_rows['essential_pressure'].mean()
ess_12pm = pm12_rows['essential_pressure'].mean()
if not np.isnan(ess_3am) and not np.isnan(ess_12pm):
    ratio_3am_vs_noon = ess_3am / ess_12pm
    print(f"\n  Essential pressure ratio (3am vs 12pm): {ratio_3am_vs_noon:.1f}x")

# ============================================================
# 5. Save CSV
# ============================================================
print("\n[6] Saving hourly aggregation CSV...")
out_csv = '/Volumes/Data/PDF_tool/research/output/service_pressure_hourly_v2.csv'
hourly_df.to_csv(out_csv, index=False)
print(f"    Saved: {out_csv}")

# ============================================================
# 6. Figure 5: 168h Service Pressure Curves
# ============================================================
print("\n[7] Generating Fig 5: 168h service pressure curves...")

hours = hourly_df['hour_idx'].values
ess_pressure = hourly_df['essential_pressure'].values
dis_pressure = hourly_df['discretionary_pressure'].values
ess_noservice = hourly_df['essential_pct_noservice'].values
dis_noservice = hourly_df['discretionary_pct_noservice'].values

# Compute 24h average (collapsed across all 7 days)
avg_24h = hourly_df.groupby('hour_of_day').agg(
    ess_mean=('essential_pressure', 'mean'),
    dis_mean=('discretionary_pressure', 'mean'),
    ess_noservice=('essential_pct_noservice', 'mean'),
    dis_noservice=('discretionary_pct_noservice', 'mean'),
).reset_index()

COLOR_ESS = "#D55E00"
COLOR_DIS = "#0072B2"
FONT_SIZE = 8
DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(7.5, 5), dpi=300)
fig.patch.set_facecolor('white')

# ---- LEFT PANEL: 168h curves ----
ax1.set_facecolor('white')

# Background bands: day/night
for d in range(7):
    base = d * 24
    # Daytime band (6-22): light gray
    ax1.axvspan(base + 6, base + 22, alpha=0.07, color='gray', zorder=0)
    # Nighttime bands (0-6 and 22-24): slightly darker
    ax1.axvspan(base, base + 6, alpha=0.13, color='gray', zorder=0)
    ax1.axvspan(base + 22, base + 24, alpha=0.13, color='gray', zorder=0)

# Vertical day separators
for d in range(1, 7):
    ax1.axvline(d * 24, color='#cccccc', linewidth=0.7, zorder=1)

# Identify high no-service regions for dashed segments
def plot_with_dash(ax, x, y, noservice, color, label, lw=1.5, threshold=0.5):
    """Plot line: dashed where pct_noservice > threshold."""
    segments_solid_x, segments_solid_y = [], []
    segments_dash_x, segments_dash_y = [], []
    for i in range(len(x)):
        if np.isnan(y[i]):
            continue
        if noservice[i] > threshold:
            segments_dash_x.append(x[i])
            segments_dash_y.append(y[i])
        else:
            segments_solid_x.append(x[i])
            segments_solid_y.append(y[i])
    # Plot solid
    if segments_solid_x:
        ax.plot(segments_solid_x, segments_solid_y, color=color, linewidth=lw,
                label=label, zorder=3, alpha=0.9)
    # Plot dashed (no label to avoid legend duplication)
    if segments_dash_x:
        ax.plot(segments_dash_x, segments_dash_y, color=color, linewidth=lw,
                linestyle='--', zorder=3, alpha=0.7)

plot_with_dash(ax1, hours, ess_pressure, ess_noservice, COLOR_ESS,
               "Essential (supermarket/convenience/grocery)")
plot_with_dash(ax1, hours, dis_pressure, dis_noservice, COLOR_DIS,
               "Discretionary (cafe/coffee/restaurant)")

# Horizontal baselines (daytime mean)
daytime_ess_mean_168 = np.nanmean(ess_pressure[daytime_mask.values]) if daytime_mask.sum() > 0 else np.nan
daytime_dis_mean_168 = np.nanmean(dis_pressure[daytime_mask.values]) if daytime_mask.sum() > 0 else np.nan

if not np.isnan(daytime_ess_mean_168):
    ax1.axhline(daytime_ess_mean_168, color=COLOR_ESS, linewidth=0.8, linestyle=':', alpha=0.6, zorder=2)
if not np.isnan(daytime_dis_mean_168):
    ax1.axhline(daytime_dis_mean_168, color=COLOR_DIS, linewidth=0.8, linestyle=':', alpha=0.6, zorder=2)

# Annotations: 3am pressure ratio
am3_ess = np.nanmean(ess_pressure[hourly_df['hour_of_day'].values == 3])
noon_ess = np.nanmean(ess_pressure[hourly_df['hour_of_day'].values == 12])
if not np.isnan(am3_ess) and not np.isnan(noon_ess) and noon_ess > 0:
    ratio_text = f"{am3_ess / noon_ess:.1f}x pressure\nat 3am vs 12pm"
    ax1.annotate(ratio_text, xy=(3, am3_ess), xytext=(10, am3_ess * 1.3),
                fontsize=6.5, color=COLOR_ESS,
                arrowprops=dict(arrowstyle='->', color=COLOR_ESS, lw=0.8),
                ha='left', va='bottom')

# X-axis: day labels
ax1.set_xticks([d * 24 + 12 for d in range(7)])
ax1.set_xticklabels(DAY_LABELS, fontsize=FONT_SIZE)
ax1.set_xlim(0, 168)

ax1.set_xlabel("Day of week", fontsize=FONT_SIZE)
ax1.set_ylabel("Residents per open facility\n(population-weighted)", fontsize=FONT_SIZE)
ax1.set_title("(A) Weekly service pressure (168h)", fontsize=FONT_SIZE + 0.5, fontweight='bold', pad=4)
ax1.tick_params(axis='both', labelsize=FONT_SIZE)
ax1.spines['top'].set_visible(False)
ax1.spines['right'].set_visible(False)

# Legend
solid_patch = Line2D([0], [0], color='#555555', linewidth=1.2, linestyle='-', label='Normal service')
dash_patch = Line2D([0], [0], color='#555555', linewidth=1.2, linestyle='--', label='>50% buildings no service')
ess_patch = mpatches.Patch(color=COLOR_ESS, label='Essential')
dis_patch = mpatches.Patch(color=COLOR_DIS, label='Discretionary')
ax1.legend(handles=[ess_patch, dis_patch, solid_patch, dash_patch],
           fontsize=6.5, loc='upper right', framealpha=0.9, edgecolor='#cccccc')

# ---- RIGHT PANEL: 24h average ----
ax2.set_facecolor('white')

hod = avg_24h['hour_of_day'].values

# Background: day/night
ax2.axvspan(0, 6, alpha=0.13, color='gray', zorder=0, label='_')
ax2.axvspan(6, 22, alpha=0.07, color='gray', zorder=0, label='_')
ax2.axvspan(22, 24, alpha=0.13, color='gray', zorder=0, label='_')

ax2.plot(hod, avg_24h['ess_mean'].values, color=COLOR_ESS, linewidth=1.8,
         label='Essential', zorder=3)
ax2.plot(hod, avg_24h['dis_mean'].values, color=COLOR_DIS, linewidth=1.8,
         linestyle='--', label='Discretionary', zorder=3)

# Fill between curves
ess_vals = avg_24h['ess_mean'].values
dis_vals = avg_24h['dis_mean'].values
valid_both = ~(np.isnan(ess_vals) | np.isnan(dis_vals))
ax2.fill_between(hod[valid_both], ess_vals[valid_both], dis_vals[valid_both],
                 alpha=0.12, color='purple', zorder=2, label='Divergence')

# Secondary y-axis: % no service
ax2b = ax2.twinx()
ax2b.fill_between(hod, avg_24h['ess_noservice'].values * 100, alpha=0.2,
                  color=COLOR_ESS, zorder=1, label='% no service (Ess.)')
ax2b.fill_between(hod, avg_24h['dis_noservice'].values * 100, alpha=0.2,
                  color=COLOR_DIS, zorder=1, label='% no service (Dis.)')
ax2b.set_ylabel("% buildings with no service", fontsize=FONT_SIZE, color='#555555')
ax2b.tick_params(axis='y', labelsize=FONT_SIZE, colors='#555555')
ax2b.set_ylim(0, 100)
ax2b.spines['top'].set_visible(False)

ax2.set_xlim(0, 23)
ax2.set_xticks(range(0, 24, 3))
ax2.set_xticklabels([f"{h}:00" for h in range(0, 24, 3)], fontsize=FONT_SIZE, rotation=45, ha='right')
ax2.set_xlabel("Hour of day (7-day average)", fontsize=FONT_SIZE)
ax2.set_ylabel("Residents per open facility\n(population-weighted)", fontsize=FONT_SIZE)
ax2.set_title("(B) Daily average service pressure", fontsize=FONT_SIZE + 0.5, fontweight='bold', pad=4)
ax2.tick_params(axis='both', labelsize=FONT_SIZE)
ax2.spines['top'].set_visible(False)
ax2.spines['right'].set_visible(False)

ax2.legend(fontsize=6.5, loc='upper left', framealpha=0.9, edgecolor='#cccccc')

plt.tight_layout(pad=1.5)
out_fig5 = '/Volumes/Data/PDF_tool/research/output/fig5_service_pressure_v2.png'
fig.savefig(out_fig5, dpi=300, bbox_inches='tight', facecolor='white')
plt.close()
print(f"    Saved: {out_fig5}")

# ============================================================
# 7. Figure 5b: Per-category 24h curves
# ============================================================
print("\n[8] Computing per-category service pressure...")

CATEGORIES = {
    "Supermarket": {"color": "#D55E00", "group": "essential", "ls": "-"},
    "Convenience store": {"color": "#E87722", "group": "essential", "ls": "-"},
    "Grocery store": {"color": "#F5A623", "group": "essential", "ls": "-"},
    "Cafe": {"color": "#0072B2", "group": "discretionary", "ls": "--"},
    "Coffee shop": {"color": "#56B4E9", "group": "discretionary", "ls": "--"},
    "Restaurant": {"color": "#009E73", "group": "discretionary", "ls": "--"},
}

# Create per-category position maps
cat_pos_map = {}
for cat in CATEGORIES:
    cat_mask = valid_poi_df['main_category'] == cat
    cat_positions = np.where(cat_mask.values)[0]
    cat_pos_map[cat] = cat_positions
    print(f"    {cat}: {len(cat_positions)} valid POIs")

# Compute pressure per category per building
cat_hourly = {cat: [] for cat in CATEGORIES}

for node_id, iso_data in isochrone.items():
    pop = node_pop.get(int(node_id), 0)
    if pop <= 0:
        continue

    inner_indices = iso_data['inner_poi_indices']
    valid_positions = [orig_to_valid_pos[idx] for idx in inner_indices
                       if idx in orig_to_valid_pos]

    if not valid_positions:
        continue

    valid_pos_arr = np.array(valid_positions, dtype=int)

    for cat in CATEGORIES:
        # Filter positions for this category
        cat_all_pos = cat_pos_map[cat]
        # Intersection: positions in both valid_pos_arr and cat_all_pos
        cat_accessible = np.intersect1d(valid_pos_arr, cat_all_pos)

        if len(cat_accessible) == 0:
            # No accessible POIs of this category: no service
            n_open_cat = np.zeros(168, dtype=int)
        else:
            n_open_cat = oh_matrix[cat_accessible, :].sum(axis=0)

        for h in range(168):
            sp = pop / n_open_cat[h] if n_open_cat[h] > 0 else np.nan
            cat_hourly[cat].append({
                'node_id': int(node_id),
                'population': pop,
                'hour_idx': h,
                'hour_of_day': h % 24,
                'pressure': sp,
            })

print("\n    Computing per-category 24h averages...")

fig5b, ax5b = plt.subplots(1, 1, figsize=(7.5, 3.5), dpi=300)
fig5b.patch.set_facecolor('white')
ax5b.set_facecolor('white')

# Background bands
ax5b.axvspan(0, 6, alpha=0.13, color='gray', zorder=0)
ax5b.axvspan(6, 22, alpha=0.07, color='gray', zorder=0)
ax5b.axvspan(22, 24, alpha=0.13, color='gray', zorder=0)

for cat, meta in CATEGORIES.items():
    cat_df = pd.DataFrame(cat_hourly[cat])
    if len(cat_df) == 0:
        continue

    avg_cat = cat_df.groupby('hour_of_day').agg(
        mean_pressure=('pressure', lambda x: np.nanmean(x))
    ).reset_index()

    ax5b.plot(avg_cat['hour_of_day'].values, avg_cat['mean_pressure'].values,
              color=meta['color'], linewidth=1.5, linestyle=meta['ls'],
              label=cat, zorder=3, alpha=0.9)

ax5b.set_xlim(0, 23)
ax5b.set_xticks(range(0, 24, 3))
ax5b.set_xticklabels([f"{h}:00" for h in range(0, 24, 3)], fontsize=FONT_SIZE, rotation=45, ha='right')
ax5b.set_xlabel("Hour of day (7-day average)", fontsize=FONT_SIZE)
ax5b.set_ylabel("Residents per open facility\n(population-weighted)", fontsize=FONT_SIZE)
ax5b.set_title("Service Pressure by Category (24h Average)", fontsize=FONT_SIZE + 1, fontweight='bold', pad=5)
ax5b.tick_params(axis='both', labelsize=FONT_SIZE)
ax5b.spines['top'].set_visible(False)
ax5b.spines['right'].set_visible(False)

# Legend with group labels
handles, labels = ax5b.get_legend_handles_labels()
ax5b.legend(handles, labels, fontsize=6.5, loc='upper right',
            framealpha=0.9, edgecolor='#cccccc',
            title='Category (orange=essential, blue=discretionary)',
            title_fontsize=6)

plt.tight_layout(pad=1.5)
out_fig5b = '/Volumes/Data/PDF_tool/research/output/fig5b_service_pressure_categories_v2.png'
fig5b.savefig(out_fig5b, dpi=300, bbox_inches='tight', facecolor='white')
plt.close()
print(f"    Saved: {out_fig5b}")

# ============================================================
# 8. Final summary
# ============================================================
print("\n" + "=" * 70)
print("COMPUTATION COMPLETE")
print("=" * 70)
print(f"  Buildings processed: {processed}")
print(f"  Total result rows: {len(df)}")
print(f"\n  Output files:")
print(f"    {out_csv}")
print(f"    {out_fig5}")
print(f"    {out_fig5b}")

print("\n  Hourly pressure summary (key hours):")
for hod_val in [0, 3, 6, 9, 12, 15, 18, 21]:
    row = hourly_df[hourly_df['hour_of_day'] == hod_val]
    ess_avg = row['essential_pressure'].mean()
    dis_avg = row['discretionary_pressure'].mean()
    ess_ns = row['essential_pct_noservice'].mean() * 100
    dis_ns = row['discretionary_pct_noservice'].mean() * 100
    print(f"    {hod_val:02d}:00  Ess: {ess_avg:8.1f} (no-svc: {ess_ns:.0f}%)  "
          f"Dis: {dis_avg:8.1f} (no-svc: {dis_ns:.0f}%)")
