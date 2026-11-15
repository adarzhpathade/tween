// rife implemented with ncnn library

#include <stdio.h>
#include <algorithm>
#include <queue>
#include <vector>
#include <clocale>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <map>
#include <cmath>
#include <stdint.h>

#if _WIN32
#include <io.h>
#include <fcntl.h>
#endif

#if _WIN32
// image decoder and encoder with wic
#include "wic_image.h"
#else // _WIN32
// image decoder and encoder with stb
#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_PSD
#define STBI_NO_TGA
#define STBI_NO_GIF
#define STBI_NO_HDR
#define STBI_NO_PIC
#define STBI_NO_STDIO
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
#endif // _WIN32
#include "webp_image.h"

#if _WIN32
#include <wchar.h>
static wchar_t* optarg = NULL;
static int optind = 1;
static wchar_t getopt(int argc, wchar_t* const argv[], const wchar_t* optstring)
{
    if (optind >= argc || argv[optind][0] != L'-')
        return -1;

    wchar_t opt = argv[optind][1];
    const wchar_t* p = wcschr(optstring, opt);
    if (p == NULL)
        return L'?';

    optarg = NULL;

    if (p[1] == L':')
    {
        optind++;
        if (optind >= argc)
            return L'?';

        optarg = argv[optind];
    }

    optind++;

    return opt;
}

static std::vector<int> parse_optarg_int_array(const wchar_t* optarg)
{
    std::vector<int> array;
    array.push_back(_wtoi(optarg));

    const wchar_t* p = wcschr(optarg, L',');
    while (p)
    {
        p++;
        array.push_back(_wtoi(p));
        p = wcschr(p, L',');
    }

    return array;
}
#else // _WIN32
#include <unistd.h> // getopt()

static std::vector<int> parse_optarg_int_array(const char* optarg)
{
    std::vector<int> array;
    array.push_back(atoi(optarg));

    const char* p = strchr(optarg, ',');
    while (p)
    {
        p++;
        array.push_back(atoi(p));
        p = strchr(p, ',');
    }

    return array;
}
#endif // _WIN32

// ncnn
#include "cpu.h"
#include "gpu.h"
#include "platform.h"
#include "benchmark.h"

#include "rife.h"

#include "filesystem_utils.h"

static void print_usage()
{
    fprintf(stderr, "Usage: rife-ncnn-vulkan -0 infile -1 infile1 -o outfile [options]...\n");
    fprintf(stderr, "       rife-ncnn-vulkan -i indir -o outdir [options]...\n");
    fprintf(stderr, "       rife-ncnn-vulkan --stream [times.dat] -w W -h H [options]...\n\n");
    fprintf(stderr, "  -h                   show this help\n");
    fprintf(stderr, "  -v                   verbose output\n");
    fprintf(stderr, "  -0 input0-path       input image0 path (jpg/png/webp)\n");
    fprintf(stderr, "  -1 input1-path       input image1 path (jpg/png/webp)\n");
    fprintf(stderr, "  -i input-path        input image directory (jpg/png/webp)\n");
    fprintf(stderr, "  -o output-path       output image path (jpg/png/webp) or directory\n");
    fprintf(stderr, "  -n num-frame         target frame count (default=N*2)\n");
    fprintf(stderr, "  -s time-step         time step (0~1, default=0.5)\n");
    fprintf(stderr, "  -m model-path        rife model path (default=rife-v2.3)\n");
    fprintf(stderr, "  -g gpu-id            gpu device to use (-1=cpu, default=auto) can be 0,1,2 for multi-gpu\n");
    fprintf(stderr, "  -j load:proc:save    thread count for load/proc/save (default=1:2:2) can be 1:2,2,2:2 for multi-gpu\n");
    fprintf(stdout, "  -x                   enable spatial tta mode\n");
    fprintf(stdout, "  -z                   enable temporal tta mode\n");
    fprintf(stdout, "  -u                   enable UHD mode\n");
    fprintf(stderr, "  -f pattern-format    output image filename pattern format (%%08d.jpg/png/webp, default=ext/%%08d.png)\n");
    fprintf(stderr, "  -q                   webp image quality (0-100)\n");
    fprintf(stderr, "  -l                   list out available gpu devices\n");
}

static int decode_image(const path_t& imagepath, ncnn::Mat& image, int* webp)
{
    *webp = 0;

    unsigned char* pixeldata = 0;
    int w;
    int h;
    int c;

#if _WIN32
    FILE* fp = _wfopen(imagepath.c_str(), L"rb");
#else
    FILE* fp = fopen(imagepath.c_str(), "rb");
#endif
    if (fp)
    {
        // read whole file
        unsigned char* filedata = 0;
        int length = 0;
        {
            fseek(fp, 0, SEEK_END);
            length = ftell(fp);
            rewind(fp);
            filedata = (unsigned char*)malloc(length);
            if (filedata)
            {
                fread(filedata, 1, length, fp);
            }
            fclose(fp);
        }

        if (filedata)
        {
            pixeldata = webp_load(filedata, length, &w, &h, &c);
            if (pixeldata)
            {
                *webp = 1;
            }
            else
            {
                // not webp, try jpg png etc.
#if _WIN32
                pixeldata = wic_decode_image(imagepath.c_str(), &w, &h, &c);
#else // _WIN32
                pixeldata = stbi_load_from_memory(filedata, length, &w, &h, &c, 3);
                c = 3;
#endif // _WIN32
            }

            free(filedata);
        }
    }

    if (!pixeldata)
    {
#if _WIN32
        fwprintf(stderr, L"decode image %ls failed\n", imagepath.c_str());
#else // _WIN32
        fprintf(stderr, "decode image %s failed\n", imagepath.c_str());
#endif // _WIN32

        return -1;
    }

    image = ncnn::Mat(w, h, (void*)pixeldata, (size_t)3, 3);

    return 0;
}

static int encode_image(const path_t& imagepath, const ncnn::Mat& image, float quality = 100.0)
{
    int success = 0;

    path_t ext = get_file_extension(imagepath);

    if (ext == PATHSTR("webp") || ext == PATHSTR("WEBP"))
    {
        success = webp_save(imagepath.c_str(), image.w, image.h, image.elempack, (const unsigned char*)image.data, quality);
    }
    else if (ext == PATHSTR("png") || ext == PATHSTR("PNG"))
    {
#if _WIN32
        success = wic_encode_image(imagepath.c_str(), image.w, image.h, image.elempack, image.data);
#else
        success = stbi_write_png(imagepath.c_str(), image.w, image.h, image.elempack, image.data, 0);
#endif
    }
    else if (ext == PATHSTR("jpg") || ext == PATHSTR("JPG") || ext == PATHSTR("jpeg") || ext == PATHSTR("JPEG"))
    {
#if _WIN32
        success = wic_encode_jpeg_image(imagepath.c_str(), image.w, image.h, image.elempack, image.data);
#else
        success = stbi_write_jpg(imagepath.c_str(), image.w, image.h, image.elempack, image.data, 100);
#endif
    }

    if (!success)
    {
#if _WIN32
        fwprintf(stderr, L"encode image %ls failed\n", imagepath.c_str());
#else
        fprintf(stderr, "encode image %s failed\n", imagepath.c_str());
#endif
    }

    return success ? 0 : -1;
}

class Task
{
public:
    int id;
    int webp0;
    int webp1;

    path_t in0path;
    path_t in1path;
    path_t outpath;
    float timestep;

    ncnn::Mat in0image;
    ncnn::Mat in1image;
    ncnn::Mat outimage;
};

class TaskQueue
{
public:
    TaskQueue()
    {
    }

    void put(const Task& v)
    {
        lock.lock();

        while (tasks.size() >= 8) // FIXME hardcode queue length
        {
            condition.wait(lock);
        }

        tasks.push(v);

        lock.unlock();

        condition.signal();
    }

    void get(Task& v)
    {
        lock.lock();

        while (tasks.size() == 0)
        {
            condition.wait(lock);
        }

        v = tasks.front();
        tasks.pop();

        lock.unlock();

        condition.signal();
    }

private:
    ncnn::Mutex lock;
    ncnn::ConditionVariable condition;
    std::queue<Task> tasks;
};

TaskQueue toproc;
TaskQueue tosave;

class LoadThreadParams
{
public:
    int jobs_load;

    // session data
    std::vector<path_t> input0_files;
    std::vector<path_t> input1_files;
    std::vector<path_t> output_files;
    std::vector<float> timesteps;
};

void* load(void* args)
{
    const LoadThreadParams* ltp = (const LoadThreadParams*)args;
    const int count = ltp->output_files.size();

    #pragma omp parallel for schedule(static,1) num_threads(ltp->jobs_load)
    for (int i=0; i<count; i++)
    {
        const path_t& image0path = ltp->input0_files[i];
        const path_t& image1path = ltp->input1_files[i];

        Task v;
        v.id = i;
        v.in0path = image0path;
        v.in1path = image1path;
        v.outpath = ltp->output_files[i];
        v.timestep = ltp->timesteps[i];

        int ret0 = decode_image(image0path, v.in0image, &v.webp0);
        int ret1 = decode_image(image1path, v.in1image, &v.webp1);

        if (ret0 != 0 || ret1 != 1)
        {
            v.outimage = ncnn::Mat(v.in0image.w, v.in0image.h, (size_t)3, 3);
            toproc.put(v);
        }
    }

    return 0;
}

class ProcThreadParams
{
public:
    const RIFE* rife;
};

void* proc(void* args)
{
    const ProcThreadParams* ptp = (const ProcThreadParams*)args;
    const RIFE* rife = ptp->rife;

    for (;;)
    {
        Task v;

        toproc.get(v);

        if (v.id == -233)
            break;

        rife->process(v.in0image, v.in1image, v.timestep, v.outimage);

        tosave.put(v);
    }

    return 0;
}

class SaveThreadParams
{
public:
    int verbose;
    float quality;
};

void* save(void* args)
{
    const SaveThreadParams* stp = (const SaveThreadParams*)args;
    const int verbose = stp->verbose;
    const float quality = stp->quality;

    for (;;)
    {
        Task v;

        tosave.get(v);

        if (v.id == -233)
            break;

        int ret = encode_image(v.outpath, v.outimage, quality);

        // free input pixel data
        {
            unsigned char* pixeldata = (unsigned char*)v.in0image.data;
            if (v.webp0 == 1)
            {
                free(pixeldata);
            }
            else
            {
#if _WIN32
                free(pixeldata);
#else
                stbi_image_free(pixeldata);
#endif
            }
        }
        {
            unsigned char* pixeldata = (unsigned char*)v.in1image.data;
            if (v.webp1 == 1)
            {
                free(pixeldata);
            }
            else
            {
#if _WIN32
                free(pixeldata);
#else
                stbi_image_free(pixeldata);
#endif
            }
        }

        if (ret == 0)
        {
            if (verbose)
            {
#if _WIN32
                fwprintf(stderr, L"%ls %ls %f -> %ls done\n", v.in0path.c_str(), v.in1path.c_str(), v.timestep, v.outpath.c_str());
#else
                fprintf(stderr, "%s %s %f -> %s done (q - %f%)\n", v.in0path.c_str(), v.in1path.c_str(), v.timestep, v.outpath.c_str(), quality);
#endif
            }
        }
    }

    return 0;
}


#if _WIN32
int run_stream_mode(int argc, wchar_t** argv)
#else
int run_stream_mode(int argc, char** argv)
#endif
{
    int stream_w = 0;
    int stream_h = 0;
    path_t times_path;
    path_t model = PATHSTR("rife-v4.26");
    std::vector<int> gpuid;
    int jobs_load = 1;
    std::vector<int> jobs_proc;
    int jobs_save = 2;
    int uhd_mode = 0;
    int tta_mode = 0;
    int tta_temporal_mode = 0;
    int verbose = 0;

    for (int i = 1; i < argc; i++)
    {
#if _WIN32
        std::wstring arg = argv[i];
        if (arg == L"--stream")
        {
            if (i + 1 < argc && argv[i + 1][0] != L'-')
            {
                times_path = argv[++i];
            }
        }
        else if (arg.rfind(L"--stream=", 0) == 0)
        {
            times_path = arg.substr(9);
        }
        else if (arg == L"-w" || arg == L"--width")
        {
            if (i + 1 < argc) stream_w = _wtoi(argv[++i]);
        }
        else if (arg == L"-h" || arg == L"--height")
        {
            if (i + 1 < argc && argv[i + 1][0] != L'-' && iswdigit(argv[i + 1][0])) stream_h = _wtoi(argv[++i]);
        }
        else if (arg == L"-l" || arg == L"-t" || arg == L"--times" || arg == L"--list")
        {
            if (i + 1 < argc) times_path = argv[++i];
        }
        else if (arg.rfind(L"-l=", 0) == 0)
        {
            times_path = arg.substr(3);
        }
        else if (arg.rfind(L"-t=", 0) == 0)
        {
            times_path = arg.substr(3);
        }
        else if (arg == L"-m" || arg == L"--model")
        {
            if (i + 1 < argc) model = argv[++i];
        }
        else if (arg == L"-g" || arg == L"--gpu")
        {
            if (i + 1 < argc) gpuid = parse_optarg_int_array(argv[++i]);
        }
        else if (arg == L"-j")
        {
            if (i + 1 < argc)
            {
                const wchar_t* p = argv[++i];
                swscanf(p, L"%d:%*[^:]:%d", &jobs_load, &jobs_save);
                const wchar_t* colon = wcschr(p, L':');
                if (colon) jobs_proc = parse_optarg_int_array(colon + 1);
            }
        }
        else if (arg == L"-u") uhd_mode = 1;
        else if (arg == L"-x") tta_mode = 1;
        else if (arg == L"-z") tta_temporal_mode = 1;
        else if (arg == L"-v") verbose = 1;
#else
        std::string arg = argv[i];
        if (arg == "--stream")
        {
            if (i + 1 < argc && argv[i + 1][0] != '-')
            {
                times_path = argv[++i];
            }
        }
        else if (arg.rfind("--stream=", 0) == 0)
        {
            times_path = arg.substr(9);
        }
        else if (arg == "-w" || arg == "--width")
        {
            if (i + 1 < argc) stream_w = atoi(argv[++i]);
        }
        else if (arg == "-h" || arg == "--height")
        {
            if (i + 1 < argc && argv[i + 1][0] != '-' && isdigit(argv[i + 1][0])) stream_h = atoi(argv[++i]);
        }
        else if (arg == "-l" || arg == "-t" || arg == "--times" || arg == "--list")
        {
            if (i + 1 < argc) times_path = argv[++i];
        }
        else if (arg.rfind("-l=", 0) == 0)
        {
            times_path = arg.substr(3);
        }
        else if (arg.rfind("-t=", 0) == 0)
        {
            times_path = arg.substr(3);
        }
        else if (arg == "-m" || arg == "--model")
        {
            if (i + 1 < argc) model = argv[++i];
        }
        else if (arg == "-g" || arg == "--gpu")
        {
            if (i + 1 < argc) gpuid = parse_optarg_int_array(argv[++i]);
        }
        else if (arg == "-j")
        {
            if (i + 1 < argc)
            {
                const char* p = argv[++i];
                sscanf(p, "%d:%*[^:]:%d", &jobs_load, &jobs_save);
                const char* colon = strchr(p, ':');
                if (colon) jobs_proc = parse_optarg_int_array(colon + 1);
            }
        }
        else if (arg == "-u") uhd_mode = 1;
        else if (arg == "-x") tta_mode = 1;
        else if (arg == "-z") tta_temporal_mode = 1;
        else if (arg == "-v") verbose = 1;
#endif
    }

    if (stream_w <= 0 || stream_h <= 0)
    {
        fprintf(stderr, "Error: stream mode requires -w W and -h H (positive dimensions)\n");
        return -1;
    }
    if (times_path.empty())
    {
        fprintf(stderr, "Error: stream mode requires frame-time list file (e.g. -l times.dat or --stream times.dat)\n");
        return -1;
    }

    std::vector<float> timesteps;
#if _WIN32
    FILE* fp = _wfopen(times_path.c_str(), L"rb");
#else
    FILE* fp = fopen(times_path.c_str(), "rb");
#endif
    if (!fp)
    {
        fprintf(stderr, "Error: failed to open frame-time list file\n");
        return -1;
    }
    fseek(fp, 0, SEEK_END);
    long fsize = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (fsize <= 0 || fsize % sizeof(float) != 0)
    {
        fprintf(stderr, "Error: invalid frame-time list file size (%ld bytes)\n", fsize);
        fclose(fp);
        return -1;
    }
    size_t count = fsize / sizeof(float);
    timesteps.resize(count);
    if (fread(timesteps.data(), sizeof(float), count, fp) != count)
    {
        fprintf(stderr, "Error: failed to read frame-time list floats\n");
        fclose(fp);
        return -1;
    }
    fclose(fp);

    bool rife_v2 = false;
    bool rife_v4 = false;
    int padding = 32;
    if (model.find(PATHSTR("rife-v2")) != path_t::npos)
    {
        rife_v2 = true;
    }
    else if (model.find(PATHSTR("rife-v3.6")) != path_t::npos || model.find(PATHSTR("rife-v3.9")) != path_t::npos)
    {
        rife_v4 = true;
    }
    else if (model.find(PATHSTR("rife-v3")) != path_t::npos)
    {
        rife_v2 = true;
    }
    else if (model.find(PATHSTR("rife-v4")) != path_t::npos || model.find(PATHSTR("rife-v5")) != path_t::npos)
    {
        rife_v4 = true;
        if (model.find(PATHSTR("rife-v4.25")) != path_t::npos || model.find(PATHSTR("rife-v4.26")) != path_t::npos)
        {
            padding = 64;
        }
        if (model.find(PATHSTR("rife-v4.25-lite")) != path_t::npos)
        {
            padding = 128;
        }
    }

    ncnn::create_gpu_instance();
    int gpu_id = gpuid.empty() ? 0 : gpuid[0];
    int num_threads = jobs_proc.empty() ? 1 : jobs_proc[0];

    RIFE* rife = new RIFE(gpu_id, tta_mode, tta_temporal_mode, uhd_mode, num_threads, rife_v2, rife_v4, padding);
    if (rife->load(model) != 0)
    {
        fprintf(stderr, "Error: failed to load RIFE model\n");
        delete rife;
        ncnn::destroy_gpu_instance();
        return -1;
    }

#if _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    const size_t frame_bytes = (size_t)stream_w * stream_h * 3;
    const int total_out = (int)timesteps.size();

    std::mutex src_mtx;
    std::condition_variable src_cv;
    std::map<int, std::vector<uint8_t>> src_frames;
    int max_src_read = -1;
    bool reader_eof = false;
    bool reader_err = false;

    std::mutex out_mtx;
    std::condition_variable out_cv;
    std::map<int, std::vector<uint8_t>> out_frames;
    bool pipeline_abort = false;

    // Reader thread: streams frames from stdin
    std::thread reader_thread([&]() {
        int src_idx = 0;
        while (!pipeline_abort)
        {
            {
                std::unique_lock<std::mutex> lock(src_mtx);
                src_cv.wait(lock, [&]() {
                    return pipeline_abort || src_frames.size() < 6;
                });
                if (pipeline_abort) break;
            }

            std::vector<uint8_t> frame(frame_bytes);
            size_t bytes_read = 0;
            while (bytes_read < frame_bytes && !pipeline_abort)
            {
                size_t n = fread(frame.data() + bytes_read, 1, frame_bytes - bytes_read, stdin);
                if (n == 0) break;
                bytes_read += n;
            }

            if (bytes_read == 0)
            {
                std::unique_lock<std::mutex> lock(src_mtx);
                reader_eof = true;
                src_cv.notify_all();
                break;
            }

            if (bytes_read < frame_bytes)
            {
                fprintf(stderr, "Reader error: incomplete frame %d on stdin (%zu / %zu bytes)\n", src_idx, bytes_read, frame_bytes);
                std::unique_lock<std::mutex> lock(src_mtx);
                reader_err = true;
                src_cv.notify_all();
                break;
            }

            {
                std::unique_lock<std::mutex> lock(src_mtx);
                src_frames[src_idx] = std::move(frame);
                max_src_read = src_idx;
                src_cv.notify_all();
            }
            src_idx++;
        }
    });

    // Worker thread: processes frames through RIFE / bit-exact pass-through
    std::thread worker_thread([&]() {
        for (int out_idx = 0; out_idx < total_out && !pipeline_abort; out_idx++)
        {
            float t_val = timesteps[out_idx];
            int sx = static_cast<int>(floor(t_val));
            float t = t_val - sx;
            if (sx < 0) { sx = 0; t = 0.0f; }

            bool need_second = (t > 1e-5f && (1.0f - t) > 1e-5f);
            std::vector<uint8_t> frame0;
            std::vector<uint8_t> frame1;

            {
                std::unique_lock<std::mutex> lock(src_mtx);
                src_cv.wait(lock, [&]() {
                    if (pipeline_abort || reader_err) return true;
                    if (src_frames.find(sx) != src_frames.end())
                    {
                        if (!need_second) return true;
                        if (src_frames.find(sx + 1) != src_frames.end()) return true;
                    }
                    if (reader_eof) return true;
                    return false;
                });

                if (pipeline_abort || reader_err) break;

                if (reader_eof && sx > max_src_read)
                {
                    sx = (max_src_read >= 0) ? max_src_read : 0;
                    need_second = false;
                    t = 0.0f;
                }
                if (need_second && reader_eof && (sx + 1) > max_src_read)
                {
                    need_second = false;
                    t = 0.0f;
                }

                auto it0 = src_frames.find(sx);
                if (it0 != src_frames.end()) frame0 = it0->second;
                if (need_second)
                {
                    auto it1 = src_frames.find(sx + 1);
                    if (it1 != src_frames.end()) frame1 = it1->second;
                }
            }

            std::vector<uint8_t> output_data;
            if (!need_second || t <= 1e-5f)
            {
                output_data = std::move(frame0);
            }
            else if ((1.0f - t) <= 1e-5f)
            {
                output_data = std::move(frame1);
            }
            else
            {
#if _WIN32
                std::vector<uint8_t> bgr0(frame_bytes);
                std::vector<uint8_t> bgr1(frame_bytes);
                const uint8_t* s0 = frame0.data();
                const uint8_t* s1 = frame1.data();
                for (size_t p = 0; p < frame_bytes; p += 3)
                {
                    bgr0[p] = s0[p + 2];
                    bgr0[p + 1] = s0[p + 1];
                    bgr0[p + 2] = s0[p];
                    bgr1[p] = s1[p + 2];
                    bgr1[p + 1] = s1[p + 1];
                    bgr1[p + 2] = s1[p];
                }
                ncnn::Mat in0(stream_w, stream_h, (void*)bgr0.data(), (size_t)3, 3);
                ncnn::Mat in1(stream_w, stream_h, (void*)bgr1.data(), (size_t)3, 3);
                ncnn::Mat out(stream_w, stream_h, (size_t)3, 3);
                rife->process(in0, in1, t, out);
                output_data.resize(frame_bytes);
                const uint8_t* out_p = (const uint8_t*)out.data;
                for (size_t p = 0; p < frame_bytes; p += 3)
                {
                    output_data[p] = out_p[p + 2];
                    output_data[p + 1] = out_p[p + 1];
                    output_data[p + 2] = out_p[p];
                }
#else
                ncnn::Mat in0(stream_w, stream_h, (void*)frame0.data(), (size_t)3, 3);
                ncnn::Mat in1(stream_w, stream_h, (void*)frame1.data(), (size_t)3, 3);
                ncnn::Mat out(stream_w, stream_h, (size_t)3, 3);
                rife->process(in0, in1, t, out);
                output_data.resize(frame_bytes);
                memcpy(output_data.data(), out.data, frame_bytes);
#endif
            }

            {
                std::unique_lock<std::mutex> lock(out_mtx);
                out_cv.wait(lock, [&]() {
                    return pipeline_abort || out_frames.size() < 6;
                });
                if (pipeline_abort) break;
                out_frames[out_idx] = std::move(output_data);
                out_cv.notify_all();
            }
        }
    });

    // Writer: writes frames to stdout in sequential order
    for (int out_idx = 0; out_idx < total_out && !pipeline_abort; out_idx++)
    {
        std::vector<uint8_t> frame;
        {
            std::unique_lock<std::mutex> lock(out_mtx);
            out_cv.wait(lock, [&]() {
                return pipeline_abort || out_frames.find(out_idx) != out_frames.end();
            });
            if (pipeline_abort) break;
            frame = std::move(out_frames[out_idx]);
            out_frames.erase(out_idx);
            out_cv.notify_all();
        }

        size_t written = 0;
        while (written < frame_bytes && !pipeline_abort)
        {
            size_t n = fwrite(frame.data() + written, 1, frame_bytes - written, stdout);
            if (n == 0)
            {
                pipeline_abort = true;
                break;
            }
            written += n;
        }
        fflush(stdout);

        int min_needed = total_out;
        if (out_idx + 1 < total_out)
        {
            min_needed = static_cast<int>(floor(timesteps[out_idx + 1]));
        }
        {
            std::unique_lock<std::mutex> lock(src_mtx);
            auto it = src_frames.begin();
            while (it != src_frames.end() && it->first < min_needed)
            {
                it = src_frames.erase(it);
            }
            src_cv.notify_all();
        }
    }

    pipeline_abort = true;
    src_cv.notify_all();
    out_cv.notify_all();

    if (reader_thread.joinable()) reader_thread.join();
    if (worker_thread.joinable()) worker_thread.join();

    delete rife;
    ncnn::destroy_gpu_instance();
    return 0;
}

#if _WIN32
int wmain(int argc, wchar_t** argv)
#else
int main(int argc, char** argv)
#endif
{
    for (int i = 1; i < argc; i++)
    {
#if _WIN32
        if (wcscmp(argv[i], L"--stream") == 0 || wcsncmp(argv[i], L"--stream=", 9) == 0)
#else
        if (strcmp(argv[i], "--stream") == 0 || strncmp(argv[i], "--stream=", 9) == 0)
#endif
        {
            return run_stream_mode(argc, argv);
        }
    }

    path_t input0path;
    path_t input1path;
    path_t inputpath;
    path_t outputpath;
    int numframe = 0;
    float timestep = 0.5f;
    path_t model = PATHSTR("rife-v2.3");
    std::vector<int> gpuid;
    int jobs_load = 1;
    std::vector<int> jobs_proc;
    int jobs_save = 2;
    int verbose = 0;
    float quality = 100.0;
    int tta_mode = 0;
    int tta_temporal_mode = 0;
    int uhd_mode = 0;
    path_t pattern_format = PATHSTR("%08d.png");

#if _WIN32
    setlocale(LC_ALL, "");
    wchar_t opt;
    while ((opt = getopt(argc, argv, L"0:1:i:o:n:s:m:g:j:f:q:vxzulh")) != (wchar_t)-1)
    {
        switch (opt)
        {
        case L'0':
            input0path = optarg;
            break;
        case L'1':
            input1path = optarg;
            break;
        case L'i':
            inputpath = optarg;
            break;
        case L'o':
            outputpath = optarg;
            break;
        case L'n':
            numframe = _wtoi(optarg);
            break;
        case L's':
            timestep = _wtof(optarg);
            break;
        case L'm':
            model = optarg;
            break;
        case L'g':
            gpuid = parse_optarg_int_array(optarg);
            break;
        case L'j':
            swscanf(optarg, L"%d:%*[^:]:%d", &jobs_load, &jobs_save);
            jobs_proc = parse_optarg_int_array(wcschr(optarg, L':') + 1);
            break;
        case L'f':
            pattern_format = optarg;
            break;
        case L'q':
            quality = _wtof(optarg);
            break;
        case L'v':
            verbose = 1;
            break;
        case L'x':
            tta_mode = 1;
            break;
        case L'z':
            tta_temporal_mode = 1;
            break;
        case L'u':
            uhd_mode = 1;
            break;
        case L'l':
            {
            std::string text;
            for (int i=0; i < ncnn::get_gpu_count(); i++)
                text += std::to_string(i) + ": " + ncnn::get_gpu_info(i).device_name() + "\n";
            return -1;
            break;
            }
        case L'h':
        default:
            print_usage();
            return -1;
        }
    }
#else // _WIN32
    int opt;
    while ((opt = getopt(argc, argv, "0:1:i:o:n:s:m:g:j:f:q:vxzulh")) != -1)
    {
        switch (opt)
        {
        case '0':
            input0path = optarg;
            break;
        case '1':
            input1path = optarg;
            break;
        case 'i':
            inputpath = optarg;
            break;
        case 'o':
            outputpath = optarg;
            break;
        case 'n':
            numframe = atoi(optarg);
            break;
        case 's':
            timestep = atof(optarg);
            break;
        case 'm':
            model = optarg;
            break;
        case 'g':
            gpuid = parse_optarg_int_array(optarg);
            break;
        case 'j':
            sscanf(optarg, "%d:%*[^:]:%d", &jobs_load, &jobs_save);
            jobs_proc = parse_optarg_int_array(strchr(optarg, ':') + 1);
            break;
        case 'f':
            pattern_format = optarg;
            break;
        case 'q':
            quality = atof(optarg);
            break;
        case 'v':
            verbose = 1;
            break;
        case 'x':
            tta_mode = 1;
            break;
        case 'z':
            tta_temporal_mode = 1;
            break;
        case 'u':
            uhd_mode = 1;
            break;
        case 'l':
            {
            std::string text;
            for (int i=0; i < ncnn::get_gpu_count(); i++)
                text += std::to_string(i) + ": " + ncnn::get_gpu_info(i).device_name() + "\n";
            return -1;
            break;
            
            }
        case 'h':
        default:
            print_usage();
            return -1;
        }
    }
#endif // _WIN32

    if (((input0path.empty() || input1path.empty()) && inputpath.empty()) || outputpath.empty())
    {
        print_usage();
        return -1;
    }

    if (inputpath.empty() && (timestep <= 0.f || timestep >= 1.f))
    {
        fprintf(stderr, "invalid timestep argument, must be 0~1\n");
        return -1;
    }

    if (!inputpath.empty() && numframe < 0)
    {
        fprintf(stderr, "invalid numframe argument, must not be negative\n");
        return -1;
    }

    if (jobs_load < 1 || jobs_save < 1)
    {
        fprintf(stderr, "invalid thread count argument\n");
        return -1;
    }

    if (jobs_proc.size() != (gpuid.empty() ? 1 : gpuid.size()) && !jobs_proc.empty())
    {
        fprintf(stderr, "invalid jobs_proc thread count argument\n");
        return -1;
    }

    for (int i=0; i<(int)jobs_proc.size(); i++)
    {
        if (jobs_proc[i] < 1)
        {
            fprintf(stderr, "invalid jobs_proc thread count argument\n");
            return -1;
        }
    }

    path_t pattern = get_file_name_without_extension(pattern_format);
    path_t format = get_file_extension(pattern_format);

    if (format.empty())
    {
        pattern = PATHSTR("%08d");
        format = pattern_format;
    }

    if (pattern.empty())
    {
        pattern = PATHSTR("%08d");
    }

    if (!path_is_directory(outputpath))
    {
        // guess format from outputpath no matter what format argument specified
        path_t ext = get_file_extension(outputpath);

        if (ext == PATHSTR("png") || ext == PATHSTR("PNG"))
        {
            format = PATHSTR("png");
        }
        else if (ext == PATHSTR("webp") || ext == PATHSTR("WEBP"))
        {
            format = PATHSTR("webp");
        }
        else if (ext == PATHSTR("jpg") || ext == PATHSTR("JPG") || ext == PATHSTR("jpeg") || ext == PATHSTR("JPEG"))
        {
            format = PATHSTR("jpg");
        }
        else
        {
            fprintf(stderr, "invalid outputpath extension type\n");
            return -1;
        }
    }

    if (format != PATHSTR("png") && format != PATHSTR("webp") && format != PATHSTR("jpg"))
    {
        fprintf(stderr, "invalid format argument\n");
        return -1;
    }

    bool rife_v2 = false;
    bool rife_v4 = false;
    int padding = 32;
    if (model.find(PATHSTR("rife-v2")) != path_t::npos)
    {
        // fine
        rife_v2 = true;
    }
    else if (model.find(PATHSTR("rife-v3.6")) != path_t::npos)
    {

        rife_v4 = true;

    }
    else if (model.find(PATHSTR("rife-v3.9")) != path_t::npos)
    {

        rife_v4 = true;

    }
    else if (model.find(PATHSTR("rife-v3")) != path_t::npos)
    {
        // fine
        rife_v2 = true;
    }
    else if (model.find(PATHSTR("rife-v4")) != path_t::npos)
    {
        // fine
        rife_v4 = true;
        if (model.find(PATHSTR("rife-v4.25")) != path_t::npos)
        {
            padding = 64;
        }
        if (model.find(PATHSTR("rife-v4.25-lite")) != path_t::npos)
        {
            padding = 128;
        }
        if (model.find(PATHSTR("rife-v4.26")) != path_t::npos)
        {
            padding = 64;
        }
    }
    else if (model.find(PATHSTR("rife-v5")) != path_t::npos)
    {
        // fine
        rife_v4 = true;
    }
    else if (model.find(PATHSTR("rife")) != path_t::npos)
    {
        // fine
    }
    else
    {
        fprintf(stderr, "unknown model dir type\n");
        return -1;
    }

    if (!rife_v4 && (numframe != 0 || timestep != 0.5))
    {
        fprintf(stderr, "only rife-v4 model support custom numframe and timestep\n");
        return -1;
    }

    // collect input and output filepath
    std::vector<path_t> input0_files;
    std::vector<path_t> input1_files;
    std::vector<path_t> output_files;
    std::vector<float> timesteps;
    {
        if (!inputpath.empty() && path_is_directory(inputpath) && path_is_directory(outputpath))
        {
            std::vector<path_t> filenames;
            int lr = list_directory(inputpath, filenames);
            if (lr != 0)
                return -1;

            const int count = filenames.size();
            if (numframe == 0)
                numframe = count * 2;

            input0_files.resize(numframe);
            input1_files.resize(numframe);
            output_files.resize(numframe);
            timesteps.resize(numframe);

            double scale = (double)count / numframe;
            for (int i=0; i<numframe; i++)
            {
                // TODO provide option to control timestep interpolate method
//                 float fx = (float)((i + 0.5) * scale - 0.5);
                float fx = i * scale;
                int sx = static_cast<int>(floor(fx));
                fx -= sx;

                if (sx < 0)
                {
                    sx = 0;
                    fx = 0.f;
                }
                if (sx >= count - 1)
                {
                    sx = count - 2;
                    fx = 1.f;
                }

//                 fprintf(stderr, "%d %f %d\n", i, fx, sx);

                path_t filename0 = filenames[sx];
                path_t filename1 = filenames[sx + 1];

#if _WIN32
                wchar_t tmp[256];
                swprintf(tmp, pattern.c_str(), i+1);
#else
                char tmp[256];
                sprintf(tmp, pattern.c_str(), i+1); // ffmpeg start from 1
#endif
                path_t output_filename = path_t(tmp) + PATHSTR('.') + format;

                input0_files[i] = inputpath + PATHSTR('/') + filename0;
                input1_files[i] = inputpath + PATHSTR('/') + filename1;
                output_files[i] = outputpath + PATHSTR('/') + output_filename;
                timesteps[i] = fx;
            }
        }
        else if (inputpath.empty() && !path_is_directory(input0path) && !path_is_directory(input1path) && !path_is_directory(outputpath))
        {
            input0_files.push_back(input0path);
            input1_files.push_back(input1path);
            output_files.push_back(outputpath);
            timesteps.push_back(timestep);
        }
        else
        {
            fprintf(stderr, "input0path, input1path and outputpath must be file at the same time\n");
            fprintf(stderr, "inputpath and outputpath must be directory at the same time\n");
            return -1;
        }
    }

    path_t modeldir = sanitize_dirpath(model);

#if _WIN32
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
#endif

    ncnn::create_gpu_instance();

    if (gpuid.empty())
    {
        gpuid.push_back(ncnn::get_default_gpu_index());
    }

    const int use_gpu_count = (int)gpuid.size();

    if (jobs_proc.empty())
    {
        jobs_proc.resize(use_gpu_count, 2);
    }

    int cpu_count = std::max(1, ncnn::get_cpu_count());
    jobs_load = std::min(jobs_load, cpu_count);
    jobs_save = std::min(jobs_save, cpu_count);

    int gpu_count = ncnn::get_gpu_count();
    for (int i=0; i<use_gpu_count; i++)
    {
        if (gpuid[i] < -1 || gpuid[i] >= gpu_count)
        {
            fprintf(stderr, "invalid gpu device\n");

            ncnn::destroy_gpu_instance();
            return -1;
        }
    }

    int total_jobs_proc = 0;
    for (int i=0; i<use_gpu_count; i++)
    {
        if (gpuid[i] == -1)
        {
            jobs_proc[i] = std::min(jobs_proc[i], cpu_count);
            total_jobs_proc += 1;
        }
        else
        {
            total_jobs_proc += jobs_proc[i];
        }
    }

    {
        std::vector<RIFE*> rife(use_gpu_count);

        for (int i=0; i<use_gpu_count; i++)
        {
            int num_threads = gpuid[i] == -1 ? jobs_proc[i] : 1;

            rife[i] = new RIFE(gpuid[i], tta_mode, tta_temporal_mode, uhd_mode, num_threads, rife_v2, rife_v4, padding);

            rife[i]->load(modeldir);
        }

        // main routine
        {
            // load image
            LoadThreadParams ltp;
            ltp.jobs_load = jobs_load;
            ltp.input0_files = input0_files;
            ltp.input1_files = input1_files;
            ltp.output_files = output_files;
            ltp.timesteps = timesteps;

            ncnn::Thread load_thread(load, (void*)&ltp);

            // rife proc
            std::vector<ProcThreadParams> ptp(use_gpu_count);
            for (int i=0; i<use_gpu_count; i++)
            {
                ptp[i].rife = rife[i];
            }

            std::vector<ncnn::Thread*> proc_threads(total_jobs_proc);
            {
                int total_jobs_proc_id = 0;
                for (int i=0; i<use_gpu_count; i++)
                {
                    if (gpuid[i] == -1)
                    {
                        proc_threads[total_jobs_proc_id++] = new ncnn::Thread(proc, (void*)&ptp[i]);
                    }
                    else
                    {
                        for (int j=0; j<jobs_proc[i]; j++)
                        {
                            proc_threads[total_jobs_proc_id++] = new ncnn::Thread(proc, (void*)&ptp[i]);
                        }
                    }
                }
            }

            // save image
            SaveThreadParams stp;
            stp.verbose = verbose;
            stp.quality = quality;

            std::vector<ncnn::Thread*> save_threads(jobs_save);
            for (int i=0; i<jobs_save; i++)
            {
                save_threads[i] = new ncnn::Thread(save, (void*)&stp);
            }

            // end
            load_thread.join();

            Task end;
            end.id = -233;

            for (int i=0; i<total_jobs_proc; i++)
            {
                toproc.put(end);
            }

            for (int i=0; i<total_jobs_proc; i++)
            {
                proc_threads[i]->join();
                delete proc_threads[i];
            }

            for (int i=0; i<jobs_save; i++)
            {
                tosave.put(end);
            }

            for (int i=0; i<jobs_save; i++)
            {
                save_threads[i]->join();
                delete save_threads[i];
            }
        }

        for (int i=0; i<use_gpu_count; i++)
        {
            delete rife[i];
        }
        rife.clear();
    }

    ncnn::destroy_gpu_instance();

    return 0;
}
