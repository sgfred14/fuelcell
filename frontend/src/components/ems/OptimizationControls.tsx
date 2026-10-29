import React, { memo } from "react";
import { Sliders, RefreshCw } from "lucide-react";

interface OptimizationControlsProps {
  baseDemand: number;
  h2Cost: number;
  onBaseDemandChange: (val: number) => void;
  onH2CostChange: (val: number) => void;
  onRecompute: () => void;
  loading: boolean;
}

export const OptimizationControls: React.FC<OptimizationControlsProps> = memo(({
  baseDemand,
  h2Cost,
  onBaseDemandChange,
  onH2CostChange,
  onRecompute,
  loading,
}) => {
  return (
    <section className="slider-group" aria-label="EMS Optimization Controls">
      <div className="slider-group-header">
        <div>
          <h2 className="slider-group-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sliders size={20} aria-hidden="true" />
            AI Dispatch Optimization Controls
          </h2>
          <small className="fine">
            Configure facility base electrical demand and hydrogen fuel pricing to recompute optimal economic dispatch.
          </small>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onRecompute}
          disabled={loading}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {loading ? (
            <>
              <RefreshCw size={16} className="spin" aria-hidden="true" />
              <span>Optimizing...</span>
            </>
          ) : (
            <>
              <RefreshCw size={16} aria-hidden="true" />
              <span>Recompute Optimal Dispatch</span>
            </>
          )}
        </button>
      </div>

      <div className="slider-grid">
        <div className="slider-item">
          <div className="slider-label-row">
            <span className="slider-name">Facility Base Load</span>
            <span className="slider-val num">{baseDemand} kW</span>
          </div>
          <input
            type="range"
            min={10}
            max={500}
            step={5}
            value={baseDemand}
            onChange={(e) => onBaseDemandChange(Number(e.target.value))}
            aria-label="Facility Base Load"
            disabled={loading}
          />
        </div>

        <div className="slider-item">
          <div className="slider-label-row">
            <span className="slider-name">Hydrogen Fuel Cost</span>
            <span className="slider-val num">${h2Cost.toFixed(2)} / kg</span>
          </div>
          <input
            type="range"
            min={1}
            max={12}
            step={0.25}
            value={h2Cost}
            onChange={(e) => onH2CostChange(Number(e.target.value))}
            aria-label="Hydrogen Fuel Cost"
            disabled={loading}
          />
        </div>
      </div>
    </section>
  );
});

OptimizationControls.displayName = "OptimizationControls";
