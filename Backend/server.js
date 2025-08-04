// server.js

// Use dotenv to manage environment variables
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
// Import the Supabase client library
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// =================================================================
// MIDDLEWARE
// =================================================================

// CORS Middleware
// This allows the frontend to communicate with the backend
app.use(
  cors({
    origin: "http://localhost:3000", // frontend URL
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json());

const path = require("path");
const frontendPath = path.join(__dirname, "..");
app.use(express.static(frontendPath));
app.use(express.static(path.join(__dirname, "..", "Frontend", "html")));

// =================================================================
// DATABASE CONNECTIONS
// =================================================================

// --- 1. MongoDB Connection ---
const MONGO_URI = "mongodb://127.0.0.1:27017/student-planner";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Successfully connected to MongoDB!"))
  .catch((err) => console.error("Failed to connect to MongoDB:", err));

// --- 2. Supabase Connection ---

const supabase = require("./supabaseClient"); //import supabae client
const { request } = require("http");

if (supabase) {
  console.log("Successfully connected to Supabase!");
}

// =================================================================
// GRADE CALCULATION FUNCTIONS
// =================================================================

function getGPA(percentage) {
  if (percentage >= 85) return 4.0;
  if (percentage >= 75) return 3.75;
  if (percentage >= 70) return 3.5;
  if (percentage >= 65) return 3.0;
  if (percentage >= 60) return 2.5;
  if (percentage >= 50) return 2.0;
  return 0.0;
}

function getGrade(percentage) {
  if (percentage >= 85) return "A+";
  if (percentage >= 75) return "A";
  if (percentage >= 70) return "B+";
  if (percentage >= 65) return "B";
  if (percentage >= 60) return "C+";
  if (percentage >= 50) return "C";
  return "F";
}

// =================================================================
// MONGODB SCHEMA & MODEL
// =================================================================

// User Schema
// This schema defines the structure of a user in MongoDB
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

// Note Schema
// This schema defines the structure of a note in MongoDB
const noteSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  courseTag: { type: String, trim: true, default: "General" },
  isPinned: { type: Boolean, default: false },
  isArchived: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  userId: { type: String, required: true, index: true }, // Links note to a user
  createdAt: { type: Date, default: Date.now },
});

const Note = mongoose.model("Note", noteSchema);

// Grade Record Schema
const gradeRecordSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  course: { type: String, required: true },
  score: { type: Number, required: true }, // percentage
  creditHours: { type: Number, required: true },
  grade: { type: String }, // e.g., "A+", "B"
  gpa: { type: Number }, // grade point for this course
  createdAt: { type: Date, default: Date.now },
});

const GradeRecord = mongoose.model("GradeRecord", gradeRecordSchema);

// =================================================================
// NEW: AUTHENTICATION MIDDLEWARE (THE "SECURITY GUARD")
// =================================================================
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  // If no token, check cookies
  if (!token) {
    const cookieToken = req.cookies?.supabaseAuthToken;
    if (cookieToken) {
      req.headers.authorization = `Bearer ${cookieToken}`;
      return next();
    }
    return res.status(401).json({ message: "No token provided." });
  }

  // Ask Supabase to identify the user from the token
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ message: "Invalid token." });
  }

  // Attach the user info to the request object for other routes to use
  req.user = user;
  next(); // If the token is valid, proceed to the requested route
};

// =================================================================
// middleware for user registration into MongoDB
// =================================================================
app.post("/api/register", async (req, res) => {
  const { userId, email } = req.body;

  try {
    // Check if user exists
    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Create new user
    const newUser = new User({ userId, email });
    await newUser.save();

    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error creating user", error });
  }
});

// Apply authMiddleware to all API routes
app.use("/api", authMiddleware);

// =================================================================
// USER INFO ENDPOINT
// =================================================================
app.get("/api/user", authMiddleware, async (req, res) => {
  try {
    // Get user info from Supabase
    const token = req.headers.authorization?.split(" ")[1];
    const { data, error } = await supabase.auth.getUser(token);

    if (error) throw error;

    res.json({
      id: data.user.id,
      email: data.user.email,
      name: data.user.user_metadata?.full_name || "",
    });
  } catch (err) {
    res.status(500).json({ message: "Error fetching user info", error: err });
  }
});

// =================================================================
// API ROUTES (please apply the security guard to all api routes)
// =================================================================

// --- MongoDB Routes for Notes Management ---
// 1. GET ALL NOTES
//    Finds all notes and sorts them to show pinned notes first.
app.get("/api/notes", async (req, res) => {
  const { view, courseTag } = req.query;
  let filter = { userId: req.user.id }; // Base filter for the logged-in user

  if (view === "deleted") filter.isDeleted = true;
  else if (view === "archive") {
    filter.isArchived = true;
    filter.isDeleted = false;
  } else if (courseTag) {
    filter.courseTag = courseTag;
    filter.isArchived = false;
    filter.isDeleted = false;
  } else {
    filter.isArchived = false;
    filter.isDeleted = false;
  }

  const notes = await Note.find(filter).sort({ isPinned: -1, createdAt: -1 });
  res.json(notes);
});

// 2. CREATE A NEW NOTE
//    Creates a new note using the data sent in the request body.
app.post("/api/notes", async (req, res) => {
  const newNote = new Note({
    title: req.body.title,
    content: req.body.content,
    courseTag: req.body.courseTag,
    userId: req.user.id, // Associate the note with the logged-in user
  });
  const savedNote = await newNote.save();
  res.status(201).json(savedNote);
});

// 3. UPDATE AN EXISTING NOTE (for content changes, pinning, etc.)
//    Finds a note by its ID and updates it with the new data.
app.put("/api/notes/:id", async (req, res) => {
  try {
    const { title, content, courseTag, isPinned, isArchived, isDeleted } =
      req.body;
    const userId = req.user.id;

    // Build an update object with only the fields that were provided
    const updateFields = {};
    if (title !== undefined) updateFields.title = title;
    if (content !== undefined) updateFields.content = content;
    if (courseTag !== undefined) updateFields.courseTag = courseTag;
    if (isPinned !== undefined) updateFields.isPinned = isPinned;
    if (isArchived !== undefined) updateFields.isArchived = isArchived;
    if (isDeleted !== undefined) updateFields.isDeleted = isDeleted;

    // Find and update only if note belongs to user
    const updatedNote = await Note.findOneAndUpdate(
      { _id: req.params.id, userId }, // Crucial: check user ownership
      { $set: updateFields },
      { new: true }
    );

    if (!updatedNote)
      return res
        .status(404)
        .json({ message: "Note not found or access denied" });
    res.json(updatedNote);
  } catch (err) {
    res.status(400).json({ message: "Update error", error: err });
  }
});

// 4. DELETE A NOTE
//    Finds a note by its ID and deletes it.
app.delete("/api/notes/:id", async (req, res) => {
  try {
    const noteToTrash = await Note.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id }, // Check ownership
      { isDeleted: true },
      { new: true }
    );

    if (!noteToTrash)
      return res
        .status(404)
        .json({ message: "Note not found or access denied" });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: "Deletion error", error: err });
  }
});
// PERMANENTLY DELETE a note
app.delete("/api/notes/:id/permanent", async (req, res) => {
  try {
    const deletedNote = await Note.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id, // Check ownership
    });

    if (!deletedNote)
      return res
        .status(404)
        .json({ message: "Note not found or access denied" });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: "Permanent deletion error", error: err });
  }
});

// 5. GET ALL UNIQUE COURSE TAGS
app.get("/api/tags", async (req, res) => {
  try {
    const tags = await Note.distinct("courseTag", {
      userId: req.user.id, // Filter by current user
      isDeleted: false,
      isArchived: false,
    });

    res.json(tags.filter(Boolean));
  } catch (err) {
    res.status(500).json({ message: "Tag fetch error", error: err });
  }
});

// =================================================================
// API ROUTES FOR GRADE RECORDS
// =================================================================

// POST - Create a new grade record
app.post("/api/grades", async (req, res) => {
  const { course, score, creditHours } = req.body;
  const userId = req.user.id;

  // Calculate grade and GPA
  const grade = getGrade(score);
  const gpa = getGPA(score);

  try {
    const newRecord = new GradeRecord({
      userId,
      course,
      score,
      creditHours,
      grade,
      gpa,
    });
    const savedRecord = await newRecord.save();
    res.status(201).json(savedRecord);
  } catch (err) {
    res.status(500).json({ message: "Error saving grade record", error: err });
  }
});

// GET - Get all grade records for current user
app.get("/api/grades", async (req, res) => {
  const userId = req.user.id;
  try {
    const records = await GradeRecord.find({ userId });
    res.json(records);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching grade records", error: err });
  }
});

// GET - Calculate overall GPA for user
app.get("/api/gpa", async (req, res) => {
  const userId = req.user.id;

  try {
    const records = await GradeRecord.find({ userId });

    if (records.length === 0) {
      return res.json({ gpa: 0, creditTotal: 0 });
    }

    const { totalGPA, totalCredit } = records.reduce(
      (acc, record) => {
        return {
          totalGPA: acc.totalGPA + record.gpa * record.creditHours,
          totalCredit: acc.totalCredit + record.creditHours,
        };
      },
      { totalGPA: 0, totalCredit: 0 }
    );

    const finalGPA = totalCredit ? totalGPA / totalCredit : 0;

    res.json({
      gpa: finalGPA.toFixed(2),
      creditTotal: totalCredit,
    });
  } catch (err) {
    res.status(500).json({ message: "Error calculating GPA", error: err });
  }
});

// DELETE - Delete a grade record
app.delete("/api/grades/:id", async (req, res) => {
  const id = req.params.id;
  const userId = req.user.id;

  try {
    const deletedRecord = await GradeRecord.findOneAndDelete({
      _id: id,
      userId,
    });
    if (!deletedRecord) {
      return res
        .status(404)
        .json({ message: "Record not found or access denied" });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: "Error deleting record", error: err });
  }
});

// =================================================================

// --- SUPABASE     ROUTES ---

// REMINDERS TABLE ---------------------------------------------------------
app.post("/api/reminders", async (request, response) => {
  const { name, reminder_time } = request.body;
  const user_id = request.user.id; // pulled securely from token

  if (!reminder_time || !name) {
    return response
      .status(400)
      .json({ error: "Missing name or reminder_time" });
  }

  const { data, error } = await supabase
    .from("sleep_reminders")
    .insert([{ user_id, name, reminder_time }]);

  if (error) {
    return response.status(500).json({ error: error.message });
  }
  //when success
  response.status(201).json(data);
});

app.get("/api/reminders", async (request, response) => {
  const user_id = request.user.id; // securely from token

  const { data, error } = await supabase
    .from("sleep_reminders")
    .select("*")
    .eq("user_id", user_id); // filter by user id

  if (error) return response.status(500).json({ error: error.message });

  res.status(200).json(data);
});

app.delete("/api/reminders/:id", async (req, res) => {
  const reminderId = req.params.id;
  const user_id = req.user.id; // Securely from the auth middleware

  const { data, error } = await supabase
    .from("sleep_reminders")
    .delete()
    .eq("id", reminderId)
    .eq("user_id", user_id); // security check

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ message: "Reminder deleted successfully", data });
});

// SLEEP SESSIONS TABLE ------------------------------------------------------

app.post("/api/sleepSessions", async (request, response) => {
  const {
    sleep_date,
    bed_time,
    wakeup_time,
    duration_str,
    interruption_note,
    dreams_note,
    sleep_quality,
  } = request.body;
  const user_id = request.user.id; // Securely from the auth middleware

  if (!sleep_date || !bed_time || !wakeup_time || !duration_str) {
    return response.status(400).json({ error: "Missing fields" });
  }

  const { data, error } = await supabase.from("sleep_sessions").insert([
    {
      user_id,
      sleep_date,
      bed_time,
      wakeup_time,
      duration_str,
      interruption_note,
      dreams_note,
    },
  ]);

  if (error) {
    return response.status(500).json({ error: error.message });
  }
  //when success
  response.status(201).json(data);
});

app.get("/api/sleepSessions", async (request, response) => {
  const user_id = request.user.id; // Securely from the auth middleware

  const { data, error } = await supabase
    .from("sleep_sessions")
    .select("*")
    .eq("user_id", user_id); // filter by user id

  if (error) return response.status(500).json({ error: error.message });

  response.status(200).json(data);
});

app.delete("/api/sleepSessions/:id", async (req, res) => {
  const sessionId = req.params.id;
  const user_id = req.user.id; // Securely from the auth middleware

  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }

  const { data, error } = await supabase
    .from("sleep_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("user_id", user_id); // security check

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ message: "Session deleted successfully", data });
});

// TASKS TABLE ---------------------------------------------------------
// create a new task
app.post("/api/tasks", async (req, res) => {
  const { title, description, category, priority_level } = req.body;
  const user_id = req.user.id; // Securely from the auth middleware

  // Validation
  if (!title || !category || !priority_level) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Add created_at timestamp
    const newTask = {
      user_id,
      title,
      description,
      category,
      priority_level,
      created_at: new Date().toISOString(), // Add this line
    };

    const { data, error } = await supabase.from("tasks").insert([newTask]); // Insert the newTask object

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({
        error: "Database error: " + error.message,
      });
    }

    res.status(201).json(data);
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// get all tasks for a user
app.get("/api/tasks", async (req, res) => {
  const user_id = req.user.id; // Securely from the auth middleware

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", user_id);

  if (error) return res.status(500).json({ error: "No task  found" });

  res.status(200).json(data);
});

// update a task
app.put("/api/tasks/:id", async (req, res) => {
  const id = req.params.id;
  const { title, description, category, priority_level } = req.body;
  const user_id = req.user.id; // Securely from the auth middleware

  if (!title || !category || !priority_level) {
    return res.status(400).json({ error: "Missing title or priolity_level" });
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({ title, description, category, priority_level })
    .eq("id", id)
    .eq("user_id", user_id); // security check

  if (error) return res.status(500).json({ error: "Task not found!" });

  res.status(200).json(data);
});

// delete a task
app.delete("/api/tasks/:id", async (req, res) => {
  const id = req.params.id;
  const user_id = req.user.id; // Securely from the auth middleware

  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }

  const { data, error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", user_id); // security check

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ message: "Task deleted successfully", data });
});

// =================================================================
// SERVER STARTUP
// =================================================================
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
