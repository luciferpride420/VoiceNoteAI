import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  analyser: AnalyserNode | null;
  isRecording: boolean;
  isPaused?: boolean;
}

export function Waveform({ analyser, isRecording, isPaused }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isRecording || !analyser || !canvasRef.current) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W;
    canvas.height = H;

    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);

    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw);
      
      if (isPaused) {
        // Draw a flat line when paused
        dataArr.fill(128);
      } else {
        analyser.getByteTimeDomainData(dataArr);
      }
      
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 2;
      ctx.strokeStyle = isPaused ? '#ff8800' : '#00d4ff';
      ctx.shadowColor = isPaused ? '#ff8800' : '#00d4ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      
      const sliceW = W / bufLen;
      let x = 0;
      
      for (let i = 0; i < bufLen; i++) {
        const v = dataArr[i] / 128;
        const y = (v * H) / 2;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceW;
      }
      ctx.lineTo(W, H / 2);
      ctx.stroke();
    };

    draw();

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isRecording, isPaused, analyser]);

  return (
    <div className="w-full h-[80px] bg-[#0d1117] rounded-xl border border-[#1e2d40] flex items-center justify-center overflow-hidden relative px-4">
      {!isRecording ? (
        <div className="text-[13px] text-[#64748b] flex items-center gap-2">
          <span>🎙️</span> Press record to begin — microphone will activate
        </div>
      ) : (
        <canvas ref={canvasRef} className="w-full h-full" />
      )}
    </div>
  );
}
