// Acronym dictionary: short form -> { full, definition }
// Used for:
//   1. Tooltip definitions in insight text
//   2. PDF keyword expansion (highlight both forms)
//   3. Query expansion for RAG retrieval (backend mirror)

const ACRONYMS = {
  // Models and architectures
  'VLM': { full: 'Vision-Language Model', definition: 'Neural model that jointly processes visual and textual input for tasks like captioning, VQA, and robotic reasoning' },
  'LLM': { full: 'Large Language Model', definition: 'Neural network trained on massive text data for language understanding and generation' },
  'CNN': { full: 'Convolutional Neural Network', definition: 'Neural network that processes grid-like data (images) using learned spatial filters' },
  'GAN': { full: 'Generative Adversarial Network', definition: 'Two-network system where a generator creates samples and a discriminator evaluates them' },
  'VAE': { full: 'Variational Autoencoder', definition: 'Generative model that learns a probabilistic latent space for diverse output generation' },
  'MLP': { full: 'Multi-Layer Perceptron', definition: 'Basic feedforward neural network with fully connected layers' },
  'ViT': { full: 'Vision Transformer', definition: 'Transformer architecture adapted for image processing by treating image patches as tokens' },
  'RNN': { full: 'Recurrent Neural Network', definition: 'Neural network with feedback connections for processing sequential data' },
  'LSTM': { full: 'Long Short-Term Memory', definition: 'RNN variant with gating mechanisms for learning long-range dependencies' },

  // Grasp planning specific
  'DoF': { full: 'Degrees of Freedom', definition: 'Number of independent parameters defining a configuration (6-DoF = x,y,z + roll,pitch,yaw)' },
  'IK': { full: 'Inverse Kinematics', definition: 'Computing joint angles needed to reach a desired end-effector position' },
  'FK': { full: 'Forward Kinematics', definition: 'Computing end-effector position from joint angles' },
  'GQ-CNN': { full: 'Grasp Quality Convolutional Neural Network', definition: 'CNN that predicts grasp success probability from depth images (Dex-Net)' },
  'GPD': { full: 'Grasp Pose Detection', definition: 'Algorithm that samples and evaluates 6-DoF grasp candidates from point clouds' },

  // Sensors and data
  'RGBD': { full: 'RGB-Depth', definition: 'Color image combined with per-pixel depth information from a depth sensor' },
  'RGB': { full: 'Red-Green-Blue', definition: 'Standard color image with three channels' },
  'TSDF': { full: 'Truncated Signed Distance Function', definition: 'Volumetric 3D representation storing distance to nearest surface at each voxel' },
  'LiDAR': { full: 'Light Detection and Ranging', definition: 'Sensor that uses laser pulses to measure distances and create 3D point clouds' },
  'IMU': { full: 'Inertial Measurement Unit', definition: 'Sensor measuring acceleration and angular velocity for motion tracking' },

  // Training and learning
  'RL': { full: 'Reinforcement Learning', definition: 'Learning approach where an agent learns by trial-and-error through reward signals' },
  'IL': { full: 'Imitation Learning', definition: 'Learning from expert demonstrations rather than reward signals' },
  'SL': { full: 'Supervised Learning', definition: 'Learning from labeled input-output pairs' },
  'SSL': { full: 'Self-Supervised Learning', definition: 'Learning representations from unlabeled data using pretext tasks' },
  'DDPG': { full: 'Deep Deterministic Policy Gradient', definition: 'RL algorithm for continuous action spaces combining actor-critic with experience replay' },
  'PPO': { full: 'Proximal Policy Optimization', definition: 'RL algorithm that constrains policy updates for stable training' },
  'SAC': { full: 'Soft Actor-Critic', definition: 'RL algorithm that maximizes both reward and entropy for robust exploration' },

  // Evaluation
  'AP': { full: 'Average Precision', definition: 'Area under the precision-recall curve, measuring detection accuracy' },
  'mAP': { full: 'Mean Average Precision', definition: 'Average of AP across multiple classes or IoU thresholds' },
  'IoU': { full: 'Intersection over Union', definition: 'Overlap ratio between predicted and ground truth regions' },
  'F1': { full: 'F1 Score', definition: 'Harmonic mean of precision and recall, balancing false positives and negatives' },

  // Simulation
  'sim-to-real': { full: 'Simulation to Real-world Transfer', definition: 'Transferring models trained in simulation to work on physical robots' },
  'DR': { full: 'Domain Randomization', definition: 'Randomizing visual and physical properties in simulation so models generalize to real conditions' },

  // Dimensionality reduction and clustering
  'UMAP': { full: 'Uniform Manifold Approximation and Projection', definition: 'Dimensionality reduction technique that preserves local and global structure for visualization' },
  'PCA': { full: 'Principal Component Analysis', definition: 'Linear dimensionality reduction that finds directions of maximum variance' },
  'HDBSCAN': { full: 'Hierarchical Density-Based Spatial Clustering', definition: 'Clustering algorithm that finds natural groups based on data density without specifying cluster count' },
  'TF-IDF': { full: 'Term Frequency-Inverse Document Frequency', definition: 'Text representation method that weights terms by importance within and across documents' },
  'RAG': { full: 'Retrieval-Augmented Generation', definition: 'Technique that retrieves relevant documents from a database before generating LLM responses' },
  'NLP': { full: 'Natural Language Processing', definition: 'AI field focused on understanding and generating human language' },
};

export default ACRONYMS;

// Helper: get all forms of keywords for highlighting
export function expandKeywordsWithAcronyms(keywords) {
  const expanded = [...keywords];
  keywords.forEach(kw => {
    const upper = kw.toUpperCase();
    if (ACRONYMS[upper]) {
      // Add full form words
      const fullWords = ACRONYMS[upper].full.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      expanded.push(ACRONYMS[upper].full);
      expanded.push(...fullWords);
    }
    // Reverse: if keyword is a full form, add the acronym
    Object.entries(ACRONYMS).forEach(([acr, { full }]) => {
      if (full.toLowerCase() === kw.toLowerCase()) {
        expanded.push(acr);
      }
    });
  });
  return [...new Set(expanded)];
}
