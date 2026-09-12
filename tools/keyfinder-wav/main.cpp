#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include <keyfinder.h>

namespace {

struct Wav {
  uint32_t sampleRate = 0;
  uint16_t channels = 0;
  std::vector<double> samples;
};

bool readWav(const std::string& path, Wav* out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    return false;
  }
  char riff[12];
  in.read(riff, 12);
  if (!in || std::strncmp(riff, "RIFF", 4) != 0 || std::strncmp(riff + 8, "WAVE", 4) != 0) {
    return false;
  }
  uint16_t audioFormat = 0;
  uint16_t bitsPerSample = 0;
  uint32_t dataBytes = 0;
  std::vector<char> data;
  while (in) {
    char id[4];
    uint32_t size = 0;
    in.read(id, 4);
    in.read(reinterpret_cast<char*>(&size), 4);
    if (!in) {
      break;
    }
    if (std::strncmp(id, "fmt ", 4) == 0) {
      uint16_t format = 0;
      uint16_t channels = 0;
      uint32_t rate = 0;
      uint32_t byteRate = 0;
      uint16_t blockAlign = 0;
      uint16_t bits = 0;
      in.read(reinterpret_cast<char*>(&format), 2);
      in.read(reinterpret_cast<char*>(&channels), 2);
      in.read(reinterpret_cast<char*>(&rate), 4);
      in.read(reinterpret_cast<char*>(&byteRate), 4);
      in.read(reinterpret_cast<char*>(&blockAlign), 2);
      in.read(reinterpret_cast<char*>(&bits), 2);
      if (size > 16) {
        in.seekg(static_cast<std::streamoff>(size - 16), std::ios::cur);
      }
      audioFormat = format;
      out->channels = channels;
      out->sampleRate = rate;
      bitsPerSample = bits;
    } else if (std::strncmp(id, "data", 4) == 0) {
      dataBytes = size;
      data.resize(size);
      in.read(data.data(), static_cast<std::streamsize>(size));
    } else {
      in.seekg(static_cast<std::streamoff>(size), std::ios::cur);
    }
  }
  if (audioFormat != 1 || bitsPerSample != 16 || out->channels == 0 || out->sampleRate == 0 || data.empty()) {
    return false;
  }
  const size_t frames = dataBytes / (static_cast<size_t>(out->channels) * 2);
  out->samples.resize(frames * out->channels);
  const auto* pcm = reinterpret_cast<const int16_t*>(data.data());
  for (size_t i = 0; i < out->samples.size(); i += 1) {
    out->samples[i] = static_cast<double>(pcm[i]) / 32768.0;
  }
  return true;
}

const char* musicalKeyName(KeyFinder::key_t key) {
  switch (key) {
    case KeyFinder::A_MAJOR:
      return "A";
    case KeyFinder::A_MINOR:
      return "Am";
    case KeyFinder::B_FLAT_MAJOR:
      return "Bb";
    case KeyFinder::B_FLAT_MINOR:
      return "Bbm";
    case KeyFinder::B_MAJOR:
      return "B";
    case KeyFinder::B_MINOR:
      return "Bm";
    case KeyFinder::C_MAJOR:
      return "C";
    case KeyFinder::C_MINOR:
      return "Cm";
    case KeyFinder::D_FLAT_MAJOR:
      return "Db";
    case KeyFinder::D_FLAT_MINOR:
      return "Dbm";
    case KeyFinder::D_MAJOR:
      return "D";
    case KeyFinder::D_MINOR:
      return "Dm";
    case KeyFinder::E_FLAT_MAJOR:
      return "Eb";
    case KeyFinder::E_FLAT_MINOR:
      return "Ebm";
    case KeyFinder::E_MAJOR:
      return "E";
    case KeyFinder::E_MINOR:
      return "Em";
    case KeyFinder::F_MAJOR:
      return "F";
    case KeyFinder::F_MINOR:
      return "Fm";
    case KeyFinder::G_FLAT_MAJOR:
      return "F#";
    case KeyFinder::G_FLAT_MINOR:
      return "F#m";
    case KeyFinder::G_MAJOR:
      return "G";
    case KeyFinder::G_MINOR:
      return "Gm";
    case KeyFinder::A_FLAT_MAJOR:
      return "Ab";
    case KeyFinder::A_FLAT_MINOR:
      return "Abm";
    default:
      return nullptr;
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: keyfinder-cli <file.wav>\n";
    return 2;
  }
  Wav wav;
  if (!readWav(argv[1], &wav)) {
    std::cerr << "failed to read 16-bit PCM WAV: " << argv[1] << "\n";
    return 1;
  }
  KeyFinder::AudioData audio;
  audio.setFrameRate(wav.sampleRate);
  audio.setChannels(wav.channels);
  audio.addToSampleCount(static_cast<unsigned int>(wav.samples.size()));
  for (size_t i = 0; i < wav.samples.size(); i += 1) {
    audio.setSample(static_cast<unsigned int>(i), wav.samples[i]);
  }
  KeyFinder::KeyFinder finder;
  const KeyFinder::key_t key = finder.keyOfAudio(audio);
  const char* name = musicalKeyName(key);
  if (name == nullptr) {
    std::cerr << "silence or unknown key\n";
    return 1;
  }
  std::cout << name << "\n";
  return 0;
}
