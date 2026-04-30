/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import Papa from 'papaparse';
import { Upload, Download, FileVideo, FileText, ArrowRightLeft, LoaderCircle, AlertCircle } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'encode' | 'decode'>('encode');
  
  // Encode State
  const [csvData, setCsvData] = useState<any[]>([]);
  const [csvColumns, setCsvColumns] = useState<string[]>([]);
  const [csvRaw, setCsvRaw] = useState<string>('');
  const [isEncoding, setIsEncoding] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState<{status: string, progress: number} | null>(null);
  const [encodeOptions, setEncodeOptions] = useState({
    width: '1280',
    height: '720',
    fps: '1',
    bitrate: 'lossless'
  });
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [encodeError, setEncodeError] = useState('');
  const [encryptVideo, setEncryptVideo] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState('');

  // Decode State
  const [decodeProgress, setDecodeProgress] = useState<{status: string, progress: number} | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [decodedCsv, setDecodedCsv] = useState<any[]>([]);
  const [decodedColumns, setDecodedColumns] = useState<string[]>([]);
  const [decodeError, setDecodeError] = useState('');
  const [decryptionKey, setDecryptionKey] = useState('');

  const encodeVideoRef = useRef<HTMLVideoElement>(null);

  const [csvFile, setCsvFile] = useState<File | null>(null);

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvFile(file);

    // Read only the first 1MB for preview and validation
    const slice = file.slice(0, 1024 * 1024);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.errors && results.errors.length > 0) {
            setEncodeError(`CSV Parsing Error: ${results.errors[0].message} (Row ${results.errors[0].row}). Please ensure your CSV is valid.`);
            setCsvData([]);
            setCsvColumns([]);
            setCsvRaw('');
            setCsvFile(null);
            setVideoUrl(null);
            setDownloadUrl(null);
            return;
          }
          if (results.meta.fields && results.meta.fields.length > 0) {
            setCsvColumns(results.meta.fields);
          } else {
            setEncodeError('Invalid CSV format: No columns found.');
            setCsvData([]);
            setCsvColumns([]);
            setCsvRaw('');
            setCsvFile(null);
            setVideoUrl(null);
            setDownloadUrl(null);
            return;
          }
          setCsvRaw(text);
          setCsvData(results.data);
          setVideoUrl(null);
          setDownloadUrl(null);
          setEncodeError('');
        },
        error: (error) => {
          setEncodeError(`Failed to parse CSV: ${error.message}. Please upload a valid CSV file.`);
          setCsvFile(null);
        }
      });
    };
    reader.readAsText(slice);
  };

  const handleEncode = async () => {
    if (!csvFile) return;
    setIsEncoding(true);
    setEncodeError('');
    setEncodeProgress(null);
    try {
      const jobId = Math.random().toString(36).substring(7);
      const formData = new FormData();
      formData.append('csv', csvFile);
      formData.append('width', encodeOptions.width);
      formData.append('height', encodeOptions.height);
      formData.append('fps', encodeOptions.fps);
      formData.append('bitrate', encodeOptions.bitrate);
      formData.append('jobId', jobId);
      if (encryptVideo && encryptionKey) {
        formData.append('encryptionKey', encryptionKey);
      }

      const pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/progress/encode/${jobId}`);
          if (res.ok) {
             const json = await res.json();
             if (json.status !== 'unknown') {
               setEncodeProgress(json);
             }
          }
        } catch (e) {}
      }, 500);

      const res = await fetch('/api/encode', {
        method: 'POST',
        body: formData
      });
      
      clearInterval(pollInterval);
      setEncodeProgress(null);

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Encode failed');
      setVideoUrl(json.url);
      setDownloadUrl(json.downloadUrl);
    } catch (err: any) {
      setEncodeError(err.message);
    } finally {
      setIsEncoding(false);
    }
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsDecoding(true);
    setDecodeError('');
    setDecodedCsv([]);
    setDecodedColumns([]);

    setDecodeProgress(null);

    const jobId = Math.random().toString(36).substring(7);
    const formData = new FormData();
    formData.append('video', file);
    formData.append('jobId', jobId);
    if (decryptionKey) {
      formData.append('decryptionKey', decryptionKey);
    }

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/progress/decode/${jobId}`);
        if (res.ok) {
           const json = await res.json();
           if (json.status !== 'unknown') {
             setDecodeProgress(json);
           }
        }
      } catch (e) {}
    }, 500);

    try {
      const res = await fetch('/api/decode', {
        method: 'POST',
        body: formData
      });
      
      clearInterval(pollInterval);
      setDecodeProgress(null);

      let json;
      try {
        const text = await res.text();
        json = JSON.parse(text);
      } catch (err) {
        if (!res.ok) {
           throw new Error(`Server returned ${res.status}: ${res.statusText}. The file might be too large or processing timed out.`);
        }
        throw new Error('Failed to parse server response.');
      }

      if (!res.ok) throw new Error(json.message || json.error || 'Decode failed');

      Papa.parse(json.data, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.errors && results.errors.length > 0) {
            setDecodeError(`Decode Error: The extracted data is not valid CSV (${results.errors[0].message}). The video might have been compressed or altered.`);
            return;
          }
          if (results.meta.fields) {
            setDecodedColumns(results.meta.fields);
          }
          setDecodedCsv(results.data);
        },
        error: (error) => {
          setDecodeError(`Failed to parse decoded text as CSV: ${error.message}. The video may be corrupted.`);
        }
      });

    } catch (err: any) {
      setDecodeError(err.message);
    } finally {
      setIsDecoding(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0B0D] text-[#E0E0E0] font-sans flex flex-col">
      <header className="flex justify-between items-end border-b border-[#2A2D32] px-8 py-6 mb-8 bg-[#0A0B0D]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#FF5500] rounded-sm shadow-[0_0_15px_rgba(255,85,0,0.4)] flex items-center justify-center">
            <ArrowRightLeft className="w-5 h-5 text-black" />
          </div>
          <div>
            <h1 className="text-3xl font-light tracking-tighter text-white">Infinite Video Storage</h1>
            <p className="text-[10px] uppercase tracking-[0.3em] mt-1 text-[#6B7280]">Encode Data inside Video Files</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-4 w-full flex-1">
        <div className="flex gap-4 mb-8">
          <button
            onClick={() => setActiveTab('encode')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold uppercase tracking-wider text-xs transition-colors shadow-sm border ${activeTab === 'encode' ? 'bg-[#1E2024] text-[#FF5500] border-[#FF5500]' : 'bg-transparent text-[#6B7280] border-[#2A2D32] hover:bg-[#1E2024]'}`}
          >
            <FileText className="w-4 h-4" />
            CSV to Video
          </button>
          <button
            onClick={() => setActiveTab('decode')}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold uppercase tracking-wider text-xs transition-colors shadow-sm border ${activeTab === 'decode' ? 'bg-[#1E2024] text-[#00EEFF] border-[#00EEFF]' : 'bg-transparent text-[#6B7280] border-[#2A2D32] hover:bg-[#1E2024]'}`}
          >
            <FileVideo className="w-4 h-4" />
            Video to CSV
          </button>
        </div>

        {activeTab === 'encode' && (
          <div className="bg-[#151619] rounded-xl shadow-2xl border border-[#2A2D32] overflow-hidden">
            <div className="bg-[#1E2024] p-4 border-b border-[#2A2D32] flex justify-between items-center">
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#FF5500] flex items-center gap-2">
                <Upload className="w-4 h-4" />
                Upload CSV File
              </h2>
              <div className="flex gap-1">
                 <div className="w-1.5 h-1.5 rounded-full bg-[#FF5500]"></div>
                 <div className="w-1.5 h-1.5 rounded-full bg-[#2A2D32]"></div>
                 <div className="w-1.5 h-1.5 rounded-full bg-[#2A2D32]"></div>
              </div>
            </div>
            
            <div className="p-6">
              <div className="mb-8">
                <label className="block w-full border-2 border-dashed border-[#2A2D32] rounded-lg p-10 flex flex-col items-center justify-center bg-[#0D0E11] group cursor-pointer hover:border-[#FF5500] transition-colors">
                  <input type="file" accept=".csv,text/csv,application/vnd.ms-excel,application/csv,text/x-csv,application/x-csv,text/comma-separated-values,text/x-comma-separated-values" className="hidden" onChange={handleCsvUpload} />
                  <FileText className="w-10 h-10 text-[#4B5563] mb-4 group-hover:text-[#FF5500] transition-colors" />
                  <p className="text-sm text-[#9CA3AF] mb-1">Click to browse or drag inside</p>
                  <p className="text-[10px] text-[#6B7280] uppercase tracking-widest">Supports .csv files (e.g. name, email, phone)</p>
                </label>
              </div>

              {encodeError && (
                <div className="mb-6 p-4 bg-red-950/30 text-red-500 rounded border border-red-900/50 flex items-center gap-3 text-sm">
                  <AlertCircle className="w-5 h-5" />
                  {encodeError}
                </div>
              )}

              {/* Encoding Options */}
              <div className="mb-8 grid grid-cols-1 md:grid-cols-3 gap-6 border-t border-[#2A2D32] pt-6">
                <div>
                  <label className="block text-[10px] text-[#6B7280] uppercase tracking-widest mb-2">Resolution</label>
                  <select 
                    value={`${encodeOptions.width}x${encodeOptions.height}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split('x');
                      setEncodeOptions(prev => ({...prev, width: w, height: h}));
                    }}
                    className="w-full bg-[#0D0E11] border border-[#2A2D32] text-[#E0E0E0] rounded p-2 text-xs focus:border-[#FF5500] outline-none"
                  >
                    <option value="640x360">640x360 (SD)</option>
                    <option value="1280x720">1280x720 (HD - Default)</option>
                    <option value="1920x1080">1920x1080 (FHD)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-[#6B7280] uppercase tracking-widest mb-2">Frame Rate</label>
                  <select 
                    value={encodeOptions.fps}
                    onChange={(e) => setEncodeOptions(prev => ({...prev, fps: e.target.value}))}
                    className="w-full bg-[#0D0E11] border border-[#2A2D32] text-[#E0E0E0] rounded p-2 text-xs focus:border-[#FF5500] outline-none"
                  >
                    <option value="1">1 FPS (Most Reliable)</option>
                    <option value="5">5 FPS</option>
                    <option value="10">10 FPS</option>
                    <option value="30">30 FPS (Fastest / Larger File)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-[#6B7280] uppercase tracking-widest mb-2">Bitrate / Quality</label>
                  <select 
                    value={encodeOptions.bitrate}
                    onChange={(e) => setEncodeOptions(prev => ({...prev, bitrate: e.target.value}))}
                    className="w-full bg-[#0D0E11] border border-[#2A2D32] text-[#E0E0E0] rounded p-2 text-xs focus:border-[#FF5500] outline-none"
                  >
                    <option value="lossless">High Quality CRF 2 (Safe)</option>
                    <option value="50M">50 Mbps (Very High)</option>
                    <option value="10M">10 Mbps (High)</option>
                    <option value="2M">2 Mbps (Risky - Data Loss)</option>
                  </select>
                </div>
                <div className="md:col-span-3 mt-2 border border-[#2A2D32] rounded p-4 bg-[#14151A]">
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input 
                      type="checkbox" 
                      checked={encryptVideo} 
                      onChange={(e) => setEncryptVideo(e.target.checked)}
                      className="accent-[#FF5500]"
                    />
                    <span className="text-xs text-[#E0E0E0] uppercase tracking-widest">Encrypt Video Data (AES-256)</span>
                  </label>
                  {encryptVideo && (
                    <div className="flex gap-4">
                      <input 
                        type="text" 
                        placeholder="Enter encryption key..."
                        value={encryptionKey}
                        onChange={(e) => setEncryptionKey(e.target.value)}
                        className="w-full bg-[#0D0E11] border border-[#2A2D32] text-[#E0E0E0] rounded p-2 text-xs focus:border-[#FF5500] outline-none"
                      />
                    </div>
                  )}
                </div>
              </div>

              {csvData.length > 0 && (
                <div className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#E0E0E0]">Preview Data ({csvData.length} rows)</h3>
                    <button
                      onClick={handleEncode}
                      disabled={isEncoding}
                      className="bg-[#FF5500] hover:bg-[#FF6622] text-black px-6 py-3 rounded shadow-[0_4px_20px_rgba(255,85,0,0.2)] font-black uppercase tracking-widest text-xs transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      {isEncoding ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <FileVideo className="w-4 h-4" />}
                      {isEncoding ? 'Encoding...' : 'Encode to Video'}
                    </button>
                  </div>
                  
                  {isEncoding && encodeProgress && (
                    <div className="mb-6 p-4 border border-[#FF5500]/30 rounded bg-[#0D0E11]">
                       <div className="flex justify-between items-center mb-2">
                         <span className="text-xs uppercase tracking-widest text-[#9CA3AF] font-bold">
                           {encodeProgress.status === 'generating_frames' ? 'Generating Frames...' : encodeProgress.status === 'encoding_video' ? 'Encoding Video with FFmpeg...' : 'Processing...'}
                         </span>
                         <span className="text-xs font-mono text-[#FF5500]">{encodeProgress.progress}%</span>
                       </div>
                       <div className="w-full bg-[#1E2024] rounded-full h-2">
                         <div className="bg-[#FF5500] h-2 rounded-full transition-all duration-300" style={{ width: `${encodeProgress.progress}%` }}></div>
                       </div>
                    </div>
                  )}

                  <div className="border border-[#2A2D32] rounded bg-[#0D0E11] shadow-inner max-h-[300px] overflow-y-auto">
                    <table className="w-full text-xs text-left font-mono">
                      <thead className="bg-[#1E2024] border-b border-[#2A2D32] text-[#9CA3AF] uppercase sticky top-0">
                        <tr>
                          {csvColumns.map((col, i) => (
                            <th key={i} className="px-4 py-3">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#2A2D32]">
                        {csvData.slice(0, 100).map((row, i) => (
                          <tr key={i} className="hover:bg-[#1E2024] transition-colors text-[#88EE88]">
                            {csvColumns.map((col, j) => (
                              <td key={j} className="px-4 py-2.5">{row[col]}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {csvData.length > 100 && (
                      <div className="p-3 text-center text-[10px] text-[#6B7280] uppercase tracking-widest bg-[#0D0E11] border-t border-[#2A2D32]">
                        Showing first 100 rows...
                      </div>
                    )}
                  </div>
                </div>
              )}

              {videoUrl && (
                <div className="mt-8 p-6 bg-[#0D0E11] rounded border border-[#FF5500]/30 animate-in fade-in slide-in-from-bottom-4 duration-500 text-center relative overflow-hidden">
                  <div className="absolute inset-0 opacity-10 rounded" style={{background: 'radial-gradient(circle, #FF5500 0%, transparent 70%)'}}></div>
                  <div className="relative z-10 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 border border-[#FF5500] text-[#FF5500] shadow-[0_0_15px_rgba(255,85,0,0.3)]">
                    <FileVideo className="w-7 h-7" />
                  </div>
                  <h3 className="text-sm font-black text-white uppercase tracking-widest mb-2">Encoding Complete</h3>
                  <p className="text-xs text-[#9CA3AF] mb-6 max-w-md mx-auto">Your CSV data has been successfully encoded into a video file container.</p>
                  <div className="flex flex-col items-center gap-4 relative z-10">
                    <video src={videoUrl} controls loop className="max-w-md w-full rounded shadow-2xl border border-[#2A2D32] bg-black"></video>
                    <a
                      href={downloadUrl || videoUrl}
                      download="data-encoded.mp4"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 bg-transparent hover:bg-[#FF5500]/10 border border-[#FF5500] text-[#FF5500] px-6 py-3 rounded font-black uppercase tracking-widest text-xs transition"
                    >
                      <Download className="w-4 h-4" />
                      Download MP4 File
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'decode' && (
          <div className="bg-[#151619] rounded-xl shadow-2xl border border-[#2A2D32] overflow-hidden">
            <div className="bg-[#1E2024] p-4 border-b border-[#2A2D32] flex justify-between items-center">
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#00EEFF] flex items-center gap-2">
                <FileVideo className="w-4 h-4" />
                Video to Data
              </h2>
              <div className="flex gap-1">
                 <div className="w-1.5 h-1.5 rounded-full bg-[#2A2D32]"></div>
                 <div className="w-1.5 h-1.5 rounded-full bg-[#2A2D32]"></div>
                 <div className="w-1.5 h-1.5 rounded-full bg-[#00EEFF]"></div>
              </div>
            </div>

            <div className="p-6">
              <div className="mb-6">
                <label className="block text-[10px] text-[#6B7280] uppercase tracking-widest mb-2">Decryption Key (if encrypted)</label>
                <input 
                  type="text" 
                  placeholder="Enter key to decrypt (Optional)..."
                  value={decryptionKey}
                  onChange={(e) => setDecryptionKey(e.target.value)}
                  className="w-full bg-[#0D0E11] border border-[#2A2D32] text-[#E0E0E0] rounded p-3 text-xs focus:border-[#00EEFF] outline-none transition-colors"
                />
              </div>

              <div className="mb-8">
                <label className={`block w-full border-2 border-dashed border-[#2A2D32] rounded-lg p-10 flex flex-col items-center justify-center bg-[#0D0E11] group cursor-pointer hover:border-[#00EEFF] transition-colors ${isDecoding ? 'opacity-50 pointer-events-none' : ''}`}>
                  <input type="file" accept="video/mp4,video/webm,.mp4,.webm" className="hidden" onChange={handleVideoUpload} disabled={isDecoding} />
                  {isDecoding ? (
                    <LoaderCircle className="w-10 h-10 text-[#00EEFF] mx-auto mb-4 animate-spin" />
                  ) : (
                    <Upload className="w-10 h-10 text-[#4B5563] group-hover:text-[#00EEFF] mb-4 transition-colors" />
                  )}
                  <p className="text-sm text-[#9CA3AF] mb-1">
                    {isDecoding ? 'Decoding video...' : 'Upload Video to Extract Data'}
                  </p>
                  <p className="text-[10px] text-[#6B7280] uppercase tracking-widest">Supports .mp4 files generated by this tool</p>
                </label>
              </div>

              {isDecoding && decodeProgress && (
                <div className="mb-6 p-4 border border-[#00EEFF]/30 rounded bg-[#0D0E11]">
                   <div className="flex justify-between items-center mb-2">
                     <span className="text-xs uppercase tracking-widest text-[#9CA3AF] font-bold">
                       {decodeProgress.status === 'extracting_frames' ? 'Extracting Frames with FFmpeg...' : decodeProgress.status === 'reading_frames' ? 'Reading Data from Frames...' : 'Processing...'}
                     </span>
                     <span className="text-xs font-mono text-[#00EEFF]">{decodeProgress.progress}%</span>
                   </div>
                   <div className="w-full bg-[#1E2024] rounded-full h-2">
                     <div className="bg-[#00EEFF] h-2 rounded-full transition-all duration-300" style={{ width: `${decodeProgress.progress}%` }}></div>
                   </div>
                </div>
              )}

              {decodeError && (
                <div className="mb-6 p-4 bg-red-950/30 text-red-500 rounded border border-red-900/50 flex items-center gap-3 text-sm">
                  <AlertCircle className="w-5 h-5" />
                  {decodeError}
                </div>
              )}

              {decodedCsv.length > 0 && (
                <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 mt-8">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#E0E0E0] flex items-center gap-2">
                       <span className="w-2 h-2 rounded-full bg-[#00EEFF] shadow-[0_0_8px_#00EEFF]"></span>
                       Recovered Data ({decodedCsv.length} rows)
                    </h3>
                    <button
                      onClick={() => {
                        const csvContent = Papa.unparse(decodedCsv);
                        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(blob);
                        link.setAttribute('download', 'decoded_data.csv');
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                      }}
                      className="bg-transparent border border-[#00EEFF] hover:bg-[#00EEFF]/10 text-[#00EEFF] px-6 py-3 rounded font-black uppercase tracking-widest text-xs transition flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" />
                      Export CSV
                    </button>
                  </div>
                  <div className="border border-[#2A2D32] rounded bg-[#0D0E11] shadow-inner max-h-[500px] overflow-y-auto">
                    <table className="w-full text-xs text-left font-mono">
                      <thead className="bg-[#1E2024] border-b border-[#2A2D32] text-[#9CA3AF] uppercase sticky top-0">
                        <tr>
                          {decodedColumns.map((col, i) => (
                            <th key={i} className="px-4 py-3">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#2A2D32]">
                        {decodedCsv.map((row, i) => (
                          <tr key={i} className="hover:bg-[#1E2024] transition-colors text-[#00EEFF]">
                            {decodedColumns.map((col, j) => (
                              <td key={j} className="px-4 py-2.5">{row[col]}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      
      <footer className="mx-6 mb-6 mt-4 flex flex-wrap justify-between items-center bg-[#0D0E11] p-4 border border-[#2A2D32] rounded-lg">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#00FF44] shadow-[0_0_8px_#00FF44]"></span>
            <span className="text-[10px] font-mono tracking-widest text-[#9CA3AF]">GPU ACCELERATION: ON</span>
          </div>
          <div className="text-[10px] font-mono tracking-widest text-[#9CA3AF]">FRAME_BUFFER: 4.2GB</div>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex gap-1">
            <div className="w-1 h-4 bg-[#FF5500] opacity-20"></div>
            <div className="w-1 h-4 bg-[#FF5500] opacity-40"></div>
            <div className="w-1 h-4 bg-[#FF5500] opacity-60"></div>
            <div className="w-1 h-4 bg-[#FF5500] opacity-100"></div>
          </div>
          <p className="text-[11px] font-bold text-white">LATENCY: 12ms</p>
        </div>
      </footer>
    </div>
  );
}
