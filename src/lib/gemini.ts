export interface AIAnalysisResult {
  summary: string;
  key_topics: string[];
  participants: string[];
  action_items: { task: string; owner?: string; due?: string }[];
  decisions: string[];
  calendar_events: { title: string; description?: string; date: string; time?: string; duration_minutes?: number }[];
}

export async function transcribeAudio(blob: Blob, mimeType: string): Promise<string> {
  try {
    const formData = new FormData();
    formData.append('audio', blob, 'audio.webm');

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to transcribe audio');
    }

    const data = await response.json();
    return data.text || '';
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

export async function analyzeTranscript(transcript: string): Promise<AIAnalysisResult> {
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transcript }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to analyze transcript');
    }

    const data = await response.json();
    return data as AIAnalysisResult;
  } catch (error) {
    console.error('Analysis error:', error);
    throw error;
  }
}
